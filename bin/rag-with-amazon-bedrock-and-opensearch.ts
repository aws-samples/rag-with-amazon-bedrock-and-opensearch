#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RagAppStack } from '../lib/rag-app-stack';
import { BaseInfraStack } from '../lib/base-infra-stack';
import { TestComputeStack } from '../lib/test-compute-stack';
import { OpenSearchStack } from '../lib/opensearch-stack';
import { OpenSearchUpdateStack } from '../lib/aoss-update-stack';

const app = new cdk.App();

// contains vpc, 
const baseInfra = new BaseInfraStack(app, 'BaseInfraStack', {
});


// for a test EC2 instance to play around with (optional)
const testComputeStack = new TestComputeStack(app, 'TestComputeStack', {
  vpc: baseInfra.vpc,
  ec2SG: baseInfra.ec2SecGroup,
});

// OpenSearch Serverless Creation. TODO: fix the stackname to be consistent
const opensearchStack = new OpenSearchStack(app, 'OpenSearchStack', {
  testComputeHostRole: testComputeStack.hostRole,
  lambdaRole: baseInfra.aossUpdateLambdaRole,
  ecsTaskRole: baseInfra.ecsTaskRole
});

// lambda function to update the aoss index upon new document landing
const aossUpdateStack = new OpenSearchUpdateStack(app, 'aossUpdateStack', {
  processedBucket: baseInfra.processedBucket,
  indexName: baseInfra.aossIndexName,
  apiKeySecret: baseInfra.apiKeySecret,
  triggerQueue: baseInfra.aossQueue,
  lambdaRole: baseInfra.aossUpdateLambdaRole,
  aossHost: opensearchStack.serverlessCollection.attrId
});

// ecs service
const ragApp = new RagAppStack(app, 'ragStack', {
  vpc: baseInfra.vpc,
  indexName: baseInfra.aossIndexName,
  apiKeySecret: baseInfra.apiKeySecret,
  taskSecGroup: baseInfra.ecsTaskSecGroup,
  aossHost: opensearchStack.serverlessCollection.attrId,
  elbTargetGroup: baseInfra.appTargetGroup,
  taskRole: baseInfra.ecsTaskRole
});
