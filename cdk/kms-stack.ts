import { Stack, StackProps } from 'aws-cdk-lib';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class KmsStack extends Stack {
  public readonly cmk: Key;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create a Customer Master Key (CMK)
    this.cmk = new Key(this, 'BgRemoverCMK', {
      description: 'CMK for background remover service',
      enableKeyRotation: true,
      alias: 'bg-remover-cmk',
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Enable IAM User Permissions',
            Effect: 'Allow',
            Principal: {
              AWS: '*',
            },
            Action: 'kms:*',
            Resource: '*',
          },
        ],
      },
    });
  }
}