import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import path = require("path");


export interface OpenSearchUpdateStackProps extends cdk.StackProps {
    processedBucket: s3.Bucket;
    indexName: string;
    apiKeySecret: secretsmanager.Secret;
    triggerQueue: sqs.Queue;
    aossHost: string;
    lambdaRole: iam.Role;
  }

export class OpenSearchUpdateStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: OpenSearchUpdateStackProps) {
    super(scope, id, props);

    // capturing architecture for docker container (arm or x86)
    const dockerPlatform = process.env["DOCKER_CONTAINER_PLATFORM_ARCH"]    
    
    // Docker assets for lambda function
    const dockerfile = path.join(__dirname, "../lambda/aoss-update/");
    
    // create a Lambda function to update the vector store everytime a new document is added to the processed bucket
    const aossUpdateFn = new lambda.Function(this, "aossUpdate", {
        code: lambda.Code.fromAssetImage(dockerfile),
        handler: lambda.Handler.FROM_IMAGE,
        runtime: lambda.Runtime.FROM_IMAGE,
        timeout: cdk.Duration.minutes(3),
        role: props.lambdaRole,
        memorySize: 512,
        architecture: dockerPlatform == "arm" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        environment: {
            "API_KEY_SECRET_NAME": props.apiKeySecret.secretName,
            "AOSS_ID": props.aossHost,
            "AOSS_INDEX_NAME": props.indexName,
            "QUEUE_URL": props.triggerQueue.queueUrl,
            "AOSS_AWS_REGION": `${this.region}`,
            // S3FileLoader (LangChain) under the hood
            "NLTK_DATA": "/tmp"
        }
    });
    // grant lambda function permissions to read processed bucket
    props.processedBucket.grantRead(aossUpdateFn);
    // grant lambda function permissions to ready the api key secret
    props.apiKeySecret.grantRead(aossUpdateFn);
    // create SQS event source
    const eventSource = new SqsEventSource(props.triggerQueue);
    // trigger Lambda function upon message in SQS queue
    aossUpdateFn.addEventSource(eventSource);

  }
}