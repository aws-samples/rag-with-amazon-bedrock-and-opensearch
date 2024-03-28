import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import path = require("path");

export interface RagAppStackProps extends cdk.StackProps {
    vpc: ec2.Vpc;
    indexName: string;
    apiKeySecret: secretsmanager.Secret;
    aossHost: string;
    taskSecGroup: ec2.SecurityGroup;
    elbTargetGroup: elbv2.ApplicationTargetGroup;
    taskRole: iam.Role;
  }

export class RagAppStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: RagAppStackProps) {
    super(scope, id, props);

    // This is the ECS cluster that we use for running tasks at.
    const cluster = new ecs.Cluster(this, "ecsClusterRAG", {
        vpc: props.vpc,
        containerInsights: true,
        executeCommandConfiguration: {
            logging: ecs.ExecuteCommandLogging.DEFAULT,
        },
    });

    // This IAM Role is used by tasks
    const taskRole = new iam.Role(this, "TaskRole", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        inlinePolicies: {
          taskRolePolicy: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: ["*"],
                actions: [
                  "cloudwatch:PutMetricData",
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                  "logs:DescribeLogStreams",
                ],
              }),
            ],
          }),
        },
    });

    // // This IAM Role is used by tasks
    // const ragTaskRole = new iam.Role(this, "RagTaskRole", {
    //     assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    //     inlinePolicies: {
    //       aossAccessPolicy: new iam.PolicyDocument({
    //         statements: [
    //           new iam.PolicyStatement({
    //             effect: iam.Effect.ALLOW,
    //             resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/*`],
    //             actions: [
    //               "aoss:APIAccessAll"
    //             ],
    //           }),
    //         ],
    //       }),          
    //       bedrockPolicy: new iam.PolicyDocument({
    //         statements: [
    //           new iam.PolicyStatement({
    //             effect: iam.Effect.ALLOW,
    //             resources: ["*"],
    //             actions: [
    //               "bedrock:InvokeModel",
    //             ],
    //           }),
    //         ],
    //       }),
    //     },
    // });
    // // grant permissions to ready the api key secret
    // props.apiKeySecret.grantRead(ragTaskRole);
  
    // This IAM role is used to execute the tasks. It is used by task definition.
    const taskExecRole = new iam.Role(this, "TaskExecRole", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AmazonECSTaskExecutionRolePolicy"
          ),
        ],
    });
  
    // We create Log Group in CloudWatch to follow task logs
    const taskLogGroup = new logs.LogGroup(this, "TaskLogGroup", {
        logGroupName: "/ragapp/",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.THREE_DAYS,
     });
    
    // We create a log driver for ecs
    const ragTaskLogDriver = new ecs.AwsLogDriver({
        streamPrefix: "rag-app",
        logGroup: taskLogGroup,
      });
    
    const dockerPlatform = process.env["DOCKER_CONTAINER_PLATFORM_ARCH"]

    // We create the task definition. Task definition is used to create tasks by ECS.
    const ragTaskDef = new ecs.FargateTaskDefinition(this, "RagTaskDef", {
      family: "rag-app",
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole: props.taskRole,
      executionRole: taskExecRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: dockerPlatform == "arm" ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64
      }
    });

    // We create a container image to be run by the tasks.
    const ragContainerImage = new ecs.AssetImage( path.join(__dirname, '../rag-app'), {
        platform: dockerPlatform == "arm" ? ecr_assets.Platform.LINUX_ARM64 : ecr_assets.Platform.LINUX_AMD64
    });
    const containerName = "ragAppOpenSearch";
    // We add this container image to our task definition that we created earlier.
    const ragContainer = ragTaskDef.addContainer("rag-container", {
        containerName: containerName,
        image: ragContainerImage,
        logging: ragTaskLogDriver,
        environment: {
            "AWS_REGION": `${this.region}`,
            "AOSS_INDEX_NAME": props.indexName,
            "AOSS_ID": props.aossHost,
            "API_KEY_SECRET_NAME": props.apiKeySecret.secretName,
        },
        portMappings: [
            {
            containerPort: 8501,
            hostPort: 8501,
            protocol: ecs.Protocol.TCP
            }, 
        ]
    });

    // define ECS fargate service to run the RAG app
    const ragAppService = new ecs.FargateService(this, "rag-app-service", {
        cluster,
        taskDefinition: ragTaskDef,
        desiredCount: 1,//vpc.availabilityZones.length,
        securityGroups: [props.taskSecGroup],
        minHealthyPercent: 0,
    });
    // add fargate service as a target to the target group
    props.elbTargetGroup.addTarget(ragAppService);

  }
}