import json
import logging
import os

import boto3
from botocore.exceptions import ClientError
from langchain_community.document_loaders import S3FileLoader
from langchain_community.vectorstores import OpenSearchVectorSearch
from langchain_openai import OpenAIEmbeddings
from opensearchpy import RequestsHttpConnection, AWSV4SignerAuth


LOGGER = logging.getLogger(__name__)

SQS_QUEUE_ENV_VAR = "QUEUE_URL"
API_KEY_SECRET_ENV_VAR = "API_KEY_SECRET_NAME"

AOSS_INDEX_NAME_ENV_VAR = "AOSS_INDEX_NAME"
AOSS_ID_ENV_VAR = "AOSS_ID"
AOSS_AWS_REGION_ENV_VAR = "AOSS_AWS_REGION"
AOSS_SVC_NAME = "aoss"

DEFAULT_TIMEOUT_AOSS = 100
DEFAULT_AOSS_ENGINE = "faiss"


class MalformedEvent(Exception):
    """Raised if a malformed event received"""


class MissingEnvironmentVariable(Exception):
    """Raised if a required environment variable is missing"""


def _silence_noisy_loggers():
    """Silence chatty libraries for better logging"""
    for logger in ['boto3', 'botocore',
                   'botocore.vendored.requests.packages.urllib3']:
        logging.getLogger(logger).setLevel(logging.WARNING)


def _configure_logger():
    """Configure python logger for lambda function"""
    default_log_args = {
        "level": logging.DEBUG if os.environ.get("VERBOSE", False) else logging.INFO,
        "format": "%(asctime)s [%(levelname)s] %(name)s - %(message)s",
        "datefmt": "%d-%b-%y %H:%M",
        "force": True,
    }
    logging.basicConfig(**default_log_args)


def _check_missing_field(validation_dict, extraction_key):
    """Check if a field exists in a dictionary

    :param validation_dict: Dictionary
    :param extraction_key: String

    :raises: KeyError
    """
    extracted_value = validation_dict.get(extraction_key)
    
    if not extracted_value:
        LOGGER.error(f"Missing '{extraction_key}' key in the dict")
        raise KeyError


def _get_message_body(event):
    """Extract message body from the event
    
    :param event: Dictionary
    
    :raises: MalformedEvent
    
    :rtype: Dictionary
    """
    body = ""
    test_event = event.get("test_event", "")
    if test_event.lower() == "true":
        LOGGER.info("processing test event (and not from SQS)")
        LOGGER.debug("Test body: %s", event)
        return event
    else:
        LOGGER.info("Attempting to extract message body from SQS")
        
        _check_missing_field(event, "Records")
        records = event["Records"]
        
        first_record = records[0]
        
        try:
            body = first_record.get("body")
        except AttributeError:
            raise MalformedEvent("First record is not a proper dict")
        
        if not body:
            raise MalformedEvent("Missing 'body' in the record")
            
        try:
            return json.loads(body)
        except json.decoder.JSONDecodeError:
            raise MalformedEvent("'body' is not valid JSON")


def _get_sqs_message_attributes(event):
    """Extract receiptHandle from message
    
    :param event: Dictionary
    
    :raises: MalformedEvent
    
    :rtype: Dictionary
    """
    LOGGER.info("Attempting to extract receiptHandle from SQS")
    records = event.get("Records")
    if not records:
        LOGGER.warning("No receiptHandle found, probably not an SQS message")
        return
    try:
        first_record = records[0]
    except IndexError:
        raise MalformedEvent("Records seem to be empty")
    
    _check_missing_field(first_record, "receiptHandle")
    receipt_handle = first_record["receiptHandle"]
    
    _check_missing_field(first_record, "messageId")
    message_id = first_record["messageId"]
    
    return {
        "message_id": message_id,
        "receipt_handle": receipt_handle
    }


def get_secret_from_name(secret_name, kv=True):
    """Return secret from secret name

    :param secret_name: String
    :param kv: Boolean (weather it is json or not)
    
    :raises: botocore.exceptions.ClientError
    
    :rtype: Dictionary
    """
    session = boto3.session.Session()

    # Initializing Secret Manager's client    
    client = session.client(
        service_name='secretsmanager',
            region_name=os.environ.get("AWS_REGION", session.region_name)
        )
    LOGGER.info(f"Attempting to get secret value for: {secret_name}")
    try:
        get_secret_value_response = client.get_secret_value(
                SecretId=secret_name)
    except ClientError as e:
        # For a list of exceptions thrown, see
        # https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
        LOGGER.error("Unable to fetch details from Secrets Manager")
        raise e
    
    _check_missing_field(
        get_secret_value_response, "SecretString")
    
    if kv:
        return json.loads(
            get_secret_value_response["SecretString"])
    else:
        return get_secret_value_response["SecretString"]


def lambda_handler(event, context):
    """What executes when the program is run"""

    # configure python logger for Lambda
    _configure_logger()
    # silence chatty libraries for better logging
    _silence_noisy_loggers()

    msg_attr = _get_sqs_message_attributes(event)
    
    if msg_attr:

        # Because messages remain in the queue
        LOGGER.info(
            f"Deleting message {msg_attr['message_id']} from sqs")
        sqs_client = boto3.client("sqs")
        queue_url = os.environ.get(SQS_QUEUE_ENV_VAR)
        if not queue_url:
            raise MissingEnvironmentVariable(
                f"{SQS_QUEUE_ENV_VAR} environment variable is required")
                
        deletion_resp = sqs_client.delete_message(
            QueueUrl=queue_url, 
            ReceiptHandle=msg_attr["receipt_handle"])
        
        sqs_client.close()

        resp_metadata = deletion_resp.get("ResponseMetadata")
        if not resp_metadata:
            raise Exception(
                "No response metadata from deletion call")
        status_code = resp_metadata.get("HTTPStatusCode")
        
        if status_code == 200:
            LOGGER.info(f"Successfully deleted message")
        else:
            raise Exception("Unable to delete message")

    body = _get_message_body(event)

    _check_missing_field(body, "bucket")
    _check_missing_field(body, "file")

    aoss_id = os.environ.get(AOSS_ID_ENV_VAR)
    if not aoss_id:
        raise MissingEnvironmentVariable(
            f"{AOSS_ID_ENV_VAR} environment variable is required")

    aoss_region = os.environ.get(AOSS_AWS_REGION_ENV_VAR)
    if not aoss_region:
        raise MissingEnvironmentVariable(
            f"{AOSS_AWS_REGION_ENV_VAR} environment variable is required")    

    index_name = os.environ.get(AOSS_INDEX_NAME_ENV_VAR)
    if not index_name:
        raise MissingEnvironmentVariable(
            f"{AOSS_INDEX_NAME_ENV_VAR} environment variable is required")
    
    openai_secret = os.environ.get(API_KEY_SECRET_ENV_VAR)
    if not openai_secret:
        raise MissingEnvironmentVariable(
            f"{API_KEY_SECRET_ENV_VAR} environment variable is required")
    os.environ["OPENAI_API_KEY"] = get_secret_from_name(
        openai_secret, kv=False)
    LOGGER.info("Fetching OpenAI embeddings")
    embeddings = OpenAIEmbeddings()

    LOGGER.info("Initializing S3FileLoader")
    loader = S3FileLoader(body['bucket'], body['file'])

    LOGGER.info(
        f"Loading document: {body['file']} from bucket: {body['bucket']}") 
    docs = loader.load()

    LOGGER.info("Setting up auth for OpenSearch Serverless")
    auth = AWSV4SignerAuth(
        boto3.Session().get_credentials(),
        aoss_region,
        AOSS_SVC_NAME
    )

    LOGGER.info("Adding new document to the vector store")
    docsearch = OpenSearchVectorSearch.from_documents(
        docs,
        embeddings,
        opensearch_url=f"{aoss_id}.{aoss_region}.{AOSS_SVC_NAME}.amazonaws.com:443",
        http_auth=auth,
        timeout=DEFAULT_TIMEOUT_AOSS,
        use_ssl=True,
        verify_certs=True,
        connection_class = RequestsHttpConnection,
        index_name=index_name,
        engine=DEFAULT_AOSS_ENGINE,
    )
