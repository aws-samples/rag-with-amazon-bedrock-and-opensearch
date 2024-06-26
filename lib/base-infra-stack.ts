import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3notif from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2_actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

import path = require("path");

export class BaseInfraStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly lambdaSG: ec2.SecurityGroup;
  readonly ecsTaskSecGroup: ec2.SecurityGroup;
  readonly knowledgeBaseBucket: s3.Bucket;
  readonly processedBucket: s3.Bucket;
  readonly aossQueue: sqs.Queue;
  readonly apiKeySecret: secretsmanager.Secret;
  readonly appTargetGroup: elbv2.ApplicationTargetGroup;
  readonly ec2SecGroup: ec2.SecurityGroup;
  readonly aossUpdateLambdaRole: iam.Role;
  readonly aossIndexName: string;
  readonly ecsTaskRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /* 
    capturing region env var to know which region to deploy this infrastructure

    NOTE - the AWS profile that is used to deploy should have the same default region
    */
    let validRegions: string[] = ['us-east-1', 'us-west-2'];
    const regionPrefix = process.env.CDK_DEFAULT_REGION || 'us-east-1';
    console.log(`CDK_DEFAULT_REGION: ${regionPrefix}`);
   // throw error if unsupported CDK_DEFAULT_REGION specified
    if (!(validRegions.includes(regionPrefix))) {
        throw new Error('Unsupported CDK_DEFAULT_REGION specified')
    };

    const indexName = process.env.AOSS_INDEX_NAME || 'rag-oai-index';
    console.log(`AOSS_INDEX_NAME: ${indexName}`);
    this.aossIndexName = indexName;

    // create VPC to deploy the infrastructure in
    const vpc = new ec2.Vpc(this, "InfraNetwork", {
      ipAddresses: ec2.IpAddresses.cidr('10.80.0.0/20'),
      availabilityZones: [`${regionPrefix}a`, `${regionPrefix}b`, `${regionPrefix}c`],
      subnetConfiguration: [
          {
            name: "public",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          }
      ],
    });
    this.vpc = vpc;

    // create bucket for knowledgeBase
    const docsBucket = new s3.Bucket(this, `knowledgeBase`, {});
    this.knowledgeBaseBucket = docsBucket;
    // use s3 bucket deploy to upload documents from local repo to the knowledgebase bucket
    new s3deploy.BucketDeployment(this, 'knowledgeBaseBucketDeploy', {
        sources: [s3deploy.Source.asset(path.join(__dirname, "../knowledgebase"))],
        destinationBucket: docsBucket
    });

    // create bucket for processed text (from PDF to txt)
    const processedTextBucket = new s3.Bucket(this, `processedText`, {});
    this.processedBucket = processedTextBucket;

    // capturing architecture for docker container (arm or x86)
    const dockerPlatform = process.env["DOCKER_CONTAINER_PLATFORM_ARCH"]

    // Docker assets for lambda function
    const dockerfile = path.join(__dirname, "../lambda/pdf-processor/");
    // create a Lambda function to process knowledgebase pdf documents
    const lambdaFn = new lambda.Function(this, "pdfProcessorFn", {
        code: lambda.Code.fromAssetImage(dockerfile),
        handler: lambda.Handler.FROM_IMAGE,
        runtime: lambda.Runtime.FROM_IMAGE,
        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
        architecture: dockerPlatform == "arm" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        environment: {
            "SOURCE_BUCKET_NAME": docsBucket.bucketName,
            "DESTINATION_BUCKET_NAME": processedTextBucket.bucketName
        }
    });
    // grant lambda function permissions to read knowledgebase bucket
    docsBucket.grantRead(lambdaFn);
    // grant lambda function permissions to write to the processed text bucket
    processedTextBucket.grantWrite(lambdaFn);

    // create a new S3 notification that triggers the pdf processor lambda function
    const kbNotification = new s3notif.LambdaDestination(lambdaFn);
    // assign notification for the s3 event type
    docsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, kbNotification);
    

    // Create security group for test ec2 instance (will be removed later)
    const ec2SecGroupName = "ec2-security-group";
    const ec2SecurityGroup = new ec2.SecurityGroup(this, ec2SecGroupName, {
        securityGroupName: ec2SecGroupName,
        vpc: vpc,
        // for internet access
        allowAllOutbound: true
    });
    this.ec2SecGroup = ec2SecurityGroup;

    // to store the API KEY for OpenAI embeddings
    const oaiSecret = 'openAiApiKey';
    const openAiApiKey = new secretsmanager.Secret(this, oaiSecret, {
      secretName: oaiSecret
    });
    this.apiKeySecret = openAiApiKey;

    // Queue for triggering opensearch update
    const aossUpdateQueue = new sqs.Queue(this, 'aossUpdateQueue', {
      queueName: "AOSS_Update_Queue",
      visibilityTimeout: cdk.Duration.minutes(5)
    });
    this.aossQueue = aossUpdateQueue;
     
    // create a Lambda function to send message to SQS for vector store updates
    const aossTriggerFn = new lambda.Function(this, "aossTrigger", {
         code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/aoss-trigger")),
         runtime: lambda.Runtime.PYTHON_3_11,
         handler: "app.lambda_handler",
         timeout: cdk.Duration.minutes(2),
         environment: {
          "AOSS_UPDATE_QUEUE": aossUpdateQueue.queueUrl,
          "BUCKET_NAME": processedTextBucket.bucketName
         }
     });
    // create a new S3 notification that triggers the opensearch trigger lambda function
    const processedBucketNotif = new s3notif.LambdaDestination(aossTriggerFn);
    // assign notification for the s3 event type
    processedTextBucket.addEventNotification(s3.EventType.OBJECT_CREATED, processedBucketNotif);
    // give permission to the function to be able to send messages to the queues
    aossUpdateQueue.grantSendMessages(aossTriggerFn);

    // lambda basic execution policy statement
    const lambdaBasicExecPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
        ],
      resources: ["*"],
    });

    // AOSS API Access
    const aossAPIAccess = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "aoss:APIAccessAll"
        ],
      resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/*`],
    });

    // role for aoss update lambda function
    const aossUpdateRole = new iam.Role(this, 'aossUpdateRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
      ),
    });
    aossUpdateRole.attachInlinePolicy(
      new iam.Policy(this, "basicExecutionLambda", {
        statements: [lambdaBasicExecPolicy]
      })
    );
    aossUpdateRole.attachInlinePolicy(
      new iam.Policy(this, "aossAPIAccess", {
        statements: [aossAPIAccess]
      })
    );    
    this.aossUpdateLambdaRole = aossUpdateRole;
    
    // This IAM Role is used by tasks
    const ragTaskRole = new iam.Role(this, "RagTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      inlinePolicies: {
        aossAccessPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/*`],
              actions: [
                "aoss:APIAccessAll"
              ],
            }),
          ],
        }),          
        bedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ["*"],
              actions: [
                "bedrock:InvokeModel",
              ],
            }),
          ],
        }),
      },
    });
    this.ecsTaskRole = ragTaskRole;
    // grant permissions to ready the api key secret
    openAiApiKey.grantRead(ragTaskRole);


    // Security group for ECS tasks
    const ragAppSecGroup = new ec2.SecurityGroup(this, "ragAppSecGroup", {
        securityGroupName: "ecs-rag-sec-group",
        vpc: vpc,
        allowAllOutbound: true,
    });
    // ragAppSecGroup.addIngressRule(
    //     ec2.Peer.ipv4("0.0.0.0/0"),
    //     ec2.Port.tcpRange(8500, 8600),
    //     "Streamlit"
    // );
    this.ecsTaskSecGroup = ragAppSecGroup;

    // Security group for ALB
    const albSecGroup = new ec2.SecurityGroup(this, "albSecGroup", {
          securityGroupName: "alb-sec-group",
          vpc: vpc,
          allowAllOutbound: true,
    });

    // create load balancer
    const appLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ragAppLb', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: albSecGroup
    });

    const certName = process.env.IAM_SELF_SIGNED_SERVER_CERT_NAME || '';
    // throw error if IAM_SELF_SIGNED_SERVER_CERT_NAME is undefined
    if (certName === undefined || certName === '') {
        throw new Error('Please specify the "IAM_SELF_SIGNED_SERVER_CERT_NAME" env var')
    };
    console.log(`self signed cert name: ${certName}`);

    const cognitoDomain = process.env.COGNITO_DOMAIN_NAME || 'rag-cog-aoss-dom';
    console.log(`cognito domain name: ${cognitoDomain}`);

    // // create Target group for ECS service
    const ecsTargetGroup = new elbv2.ApplicationTargetGroup(this, 'default', {
      vpc: vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8501
    });
    this.appTargetGroup = ecsTargetGroup;

    // // Queue for triggering app client creation
    const appClientCreationQueue = new sqs.Queue(this, 'appClientCreateQueue', {
      queueName: "COG_APP_CLIENT_CREATE_QUEUE",
      visibilityTimeout: cdk.Duration.minutes(5)
    });

    // // create a Lambda function to send message to SQS for vector store updates
    const appClientCreateTriggerFn = new lambda.Function(this, "appClientCreateTrigger", {
        code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/app-client-create-trigger")),
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "app.lambda_handler",
        timeout: cdk.Duration.minutes(2),
        environment: {
          "TRIGGER_QUEUE": appClientCreationQueue.queueUrl,
        }
      });
    // give permission to the function to be able to send messages to the queues
    appClientCreationQueue.grantSendMessages(appClientCreateTriggerFn);

    // Trigger an event when there is a Cognito CreateUserPoolClient call recorded in CloudTrail
    const appClientCreateRule = new events.Rule(this, 'appClientCreateRule', {
        eventPattern: {
            source: ["aws.cognito-idp"],
            detail: {
            eventSource: ["cognito-idp.amazonaws.com"],
            eventName: ["CreateUserPoolClient"],
            sourceIPAddress: ["cloudformation.amazonaws.com"]
            }
        },
    });
    appClientCreateRule.node.addDependency(appClientCreationQueue);
    // Invoke the callBack update fn upon a matching event
    appClientCreateRule.addTarget(new targets.LambdaFunction(appClientCreateTriggerFn));

    // create cognito user pool
    const userPool = new cognito.UserPool(this, "UserPool", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: true,
      signInAliases: { email: true},
      autoVerify: { email: true }
    });
    userPool.node.addDependency(appClientCreateRule);

    // create cognito user pool domain
    const userPoolDomain = new cognito.UserPoolDomain(this, 'upDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: cognitoDomain
      }
    });

    // create and add Application Integration for the User Pool
    const client = userPool.addClient("WebClient", {
      userPoolClientName: "MyAppWebClient",
      idTokenValidity: cdk.Duration.days(1),
      accessTokenValidity: cdk.Duration.days(1),
      generateSecret: true,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: {authorizationCodeGrant: true},
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [ `https://${appLoadBalancer.loadBalancerDnsName}/oauth2/idpresponse` ]
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO]
    });
    client.node.addDependency(appClientCreateRule);

    // add https listener to the load balancer
    const httpsListener = appLoadBalancer.addListener("httpsListener", {
      port: 443,
      open: true,
      certificates: [
        {
          certificateArn: `arn:aws:iam::${this.account}:server-certificate/${certName}`
        },
      ],
      defaultAction: new elbv2_actions.AuthenticateCognitoAction({
        userPool: userPool,
        userPoolClient: client,
        userPoolDomain: userPoolDomain,
        next: elbv2.ListenerAction.forward([ecsTargetGroup])
      })
    });
    /* 
    
    create lambda function because ALB dns name is not lowercase, 
    and cognito does not function as intended due to that
    
    Reference - https://github.com/aws/aws-cdk/issues/11171

    */
    const callBackInitFn = new lambda.Function(this, "callBackInit", {
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/call-back-url-init")),
      runtime: lambda.Runtime.PYTHON_3_11,
      timeout: cdk.Duration.minutes(2),
      handler: "app.lambda_handler",
      environment:{
        "USER_POOL_ID": userPool.userPoolId,
        "APP_CLIENT_ID": client.userPoolClientId,
        "ALB_DNS_NAME": appLoadBalancer.loadBalancerDnsName,
        "SQS_QUEUE_URL": appClientCreationQueue.queueUrl,
      },
    });
    callBackInitFn.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonCognitoPowerUser")
    );
    // create SQS event source
    const appClientCreateSqsEventSource = new SqsEventSource(appClientCreationQueue);
    // trigger Lambda function upon message in SQS queue
    callBackInitFn.addEventSource(appClientCreateSqsEventSource);

    const callBackUpdateFn = new lambda.Function(this, "callBackUpdate", {
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/call-back-url-update")),
      runtime: lambda.Runtime.PYTHON_3_11,
      timeout: cdk.Duration.minutes(2),
      handler: "app.lambda_handler",
      environment:{
        "USER_POOL_ID": userPool.userPoolId,
        "APP_CLIENT_ID": client.userPoolClientId,
        "ALB_DNS_NAME": appLoadBalancer.loadBalancerDnsName
      },
    });
    callBackUpdateFn.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonCognitoPowerUser")
    );

    // Trigger an event when there is a Cognito CreateUserPoolClient call recorded in CloudTrail
    const appClientUpdateRule = new events.Rule(this, 'appClientUpdateRule', {
        eventPattern: {
            source: ["aws.cognito-idp"],
            detail: {
            eventSource: ["cognito-idp.amazonaws.com"],
            eventName: ["UpdateUserPoolClient"],
            sourceIPAddress: ["cloudformation.amazonaws.com"]
            }
        },
    });
    // Invoke the callBack update fn upon a matching event
    appClientUpdateRule.addTarget(new targets.LambdaFunction(callBackUpdateFn)); 
    
  }
}
