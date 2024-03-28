import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';
import * as iam from 'aws-cdk-lib/aws-iam';


export interface OpenSearchStackProps extends cdk.StackProps {
    testComputeHostRole: iam.Role;
    lambdaRole: iam.Role;
    ecsTaskRole: iam.Role;
}

export class OpenSearchStack extends cdk.Stack {
  readonly jumpHostSG: ec2.SecurityGroup;
  readonly collectionName: string;
  readonly serverlessCollection: aoss.CfnCollection;

  constructor(scope: Construct, id: string, props: OpenSearchStackProps) {
    super(scope, id, props);

    this.collectionName = process.env.OPENSEARCH_COLLECTION_NAME || 'rag-collection';
    console.log(`Opensearch serverless collection name: ${this.collectionName}`);

    const networkSecurityPolicy = new aoss.CfnSecurityPolicy(this, 'aossNetworkSecPolicy', {
        policy: JSON.stringify([{
            "Rules": [
              {
                "Resource": [
                  `collection/${this.collectionName}`
                ],
                "ResourceType": "dashboard"
              },
              {
                "Resource": [
                  `collection/${this.collectionName}`
                ],
                "ResourceType": "collection"
              }
            ],
            "AllowFromPublic": true
        }]),
        name: `${this.collectionName}-sec-policy`,
        type: "network"
    });

    const encryptionSecPolicy = new aoss.CfnSecurityPolicy(this, 'aossEncryptionSecPolicy', {
        name: `${this.collectionName}-enc-sec-pol`,
        type: "encryption",
        policy: JSON.stringify({
            "Rules": [
                {
                  "Resource": [
                    `collection/${this.collectionName}`
                  ],
                  "ResourceType": "collection"
                }
              ],
              "AWSOwnedKey": true
        }),   
    });

    const aossCollecton = new aoss.CfnCollection(this, 'serverlessCollectionRag', {
        name: this.collectionName,
        description: "Collection to power RAG searches",
        type: "VECTORSEARCH"
    });
    this.serverlessCollection = aossCollecton;
    aossCollecton.addDependency(networkSecurityPolicy);
    aossCollecton.addDependency(encryptionSecPolicy);

    const dataAccessPolicy = new aoss.CfnAccessPolicy(this, 'dataAccessPolicy', {
        name: `${this.collectionName}-dap`,
        description: `Data access policy for: ${this.collectionName}`,
        type: "data",
        policy: JSON.stringify([
            {
              "Rules": [
                {
                  "Resource": [
                    `collection/${this.collectionName}`
                  ],
                  "Permission": [
                    "aoss:CreateCollectionItems",
                    "aoss:DeleteCollectionItems",
                    "aoss:UpdateCollectionItems",
                    "aoss:DescribeCollectionItems"
                  ],
                  "ResourceType": "collection"
                },
                {
                  "Resource": [
                    `index/${this.collectionName}/*`
                  ],
                  "Permission": [
                    "aoss:CreateIndex",
                    "aoss:DeleteIndex",
                    "aoss:UpdateIndex",
                    "aoss:DescribeIndex",
                    "aoss:ReadDocument",
                    "aoss:WriteDocument"
                  ],
                  "ResourceType": "index"
                }
              ],
              "Principal": [
                props.testComputeHostRole.roleArn,
                `arn:aws:iam::${this.account}:role/Admin`,
                props.lambdaRole.roleArn,
                props.ecsTaskRole.roleArn
              ],
              "Description": "data-access-rule"
            }
          ]),   
    });


  }
}
