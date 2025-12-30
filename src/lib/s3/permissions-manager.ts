import { S3Client, GetBucketPolicyCommand, PutBucketPolicyCommand, ListBucketsCommand } from '@aws-sdk/client-s3';

export interface S3PermissionsConfig {
  region?: string;
  stage: string;
  tenant: string;
  enableGranularPermissions?: boolean;
}

export interface BucketPermissions {
  bucketName: string;
  tenant: string;
  stage: string;
  allowedActions: string[];
  deniedActions: string[];
  resourcePatterns: string[];
}

export class S3PermissionsManager {
  private s3Client: S3Client;
  private config: Required<S3PermissionsConfig>;

  constructor(config: S3PermissionsConfig) {
    this.config = {
      region: config.region || process.env.AWS_REGION || 'eu-west-1',
      stage: config.stage,
      tenant: config.tenant,
      enableGranularPermissions: config.enableGranularPermissions !== false,
    };

    this.s3Client = new S3Client({ region: this.config.region });
  }

  /**
   * Generate least-privilege bucket policy for bg-remover service
   */
  generateBucketPolicy(bucketName: string): string {
    const principal = `arn:aws:iam::${process.env.AWS_ACCOUNT_ID || '*'}:role/bg-remover-${this.config.stage}`;

    const policy = {
      Version: '2012-10-17',
      Statement: [
        // Allow read access to input images
        {
          Sid: 'AllowReadInputImages',
          Effect: 'Allow',
          Principal: { AWS: principal },
          Action: [
            's3:GetObject',
            's3:GetObjectVersion',
          ],
          Resource: `arn:aws:s3:::${bucketName}/input/*`,
          Condition: {
            StringEquals: {
              's3:prefix': 'input/',
            },
          },
        },
        // Allow write access to processed images
        {
          Sid: 'AllowWriteProcessedImages',
          Effect: 'Allow',
          Principal: { AWS: principal },
          Action: [
            's3:PutObject',
            's3:PutObjectAcl',
          ],
          Resource: `arn:aws:s3:::${bucketName}/processed/${this.config.tenant}/*`,
        },
        // Allow list access to tenant-specific prefixes
        {
          Sid: 'AllowListTenantPrefix',
          Effect: 'Allow',
          Principal: { AWS: principal },
          Action: 's3:ListBucket',
          Resource: `arn:aws:s3:::${bucketName}`,
          Condition: {
            StringLike: {
              's3:prefix': `${this.config.tenant}/*`,
            },
          },
        },
        // Deny access to other tenants' data
        {
          Sid: 'DenyOtherTenants',
          Effect: 'Deny',
          Principal: { AWS: principal },
          Action: 's3:*',
          Resource: [
            `arn:aws:s3:::${bucketName}/*`,
            `arn:aws:s3:::${bucketName}`,
          ],
          Condition: {
            StringNotLike: {
              's3:prefix': [
                `${this.config.tenant}/*`,
                'input/*', // Allow reading from shared input
              ],
            },
          },
        },
        // Deny delete operations (immutable processed images)
        {
          Sid: 'DenyDeleteOperations',
          Effect: 'Deny',
          Principal: { AWS: principal },
          Action: [
            's3:DeleteObject',
            's3:DeleteObjectVersion',
          ],
          Resource: `arn:aws:s3:::${bucketName}/*`,
        },
      ],
    };

    return JSON.stringify(policy, null, 2);
  }

  /**
   * Apply least-privilege policy to S3 bucket
   */
  async applyBucketPolicy(bucketName: string): Promise<void> {
    try {
      const policyDocument = this.generateBucketPolicy(bucketName);

      const command = new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: policyDocument,
      });

      await this.s3Client.send(command);

      console.info('Applied least-privilege S3 bucket policy', {
        bucketName,
        tenant: this.config.tenant,
        stage: this.config.stage,
        policySize: policyDocument.length,
      });
    } catch (error) {
      console.error('Failed to apply S3 bucket policy', {
        bucketName,
        tenant: this.config.tenant,
        stage: this.config.stage,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to apply bucket policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get current bucket policy for analysis
   */
  async getBucketPolicy(bucketName: string): Promise<string | null> {
    try {
      const command = new GetBucketPolicyCommand({
        Bucket: bucketName,
      });

      const response = await this.s3Client.send(command);
      return response.Policy || null;
    } catch (error: any) {
      if (error.name === 'NoSuchBucketPolicy') {
        console.info('No bucket policy found', { bucketName });
        return null;
      }

      console.error('Failed to get bucket policy', {
        bucketName,
        error: error.message,
      });
      throw new Error(`Failed to get bucket policy: ${error.message}`);
    }
  }

  /**
   * Validate bucket policy against least-privilege requirements
   */
  validateBucketPolicy(policyDocument: string): {
    isValid: boolean;
    violations: string[];
    recommendations: string[];
  } {
    const violations: string[] = [];
    const recommendations: string[] = [];

    try {
      const policy = JSON.parse(policyDocument);

      // Check for wildcard permissions
      const hasWildcardActions = policy.Statement?.some((stmt: any) =>
        stmt.Action === '*' || (Array.isArray(stmt.Action) && stmt.Action.includes('*'))
      );

      if (hasWildcardActions) {
        violations.push('Policy contains wildcard (*) actions - violates least privilege');
        recommendations.push('Replace wildcard actions with specific S3 actions (s3:GetObject, s3:PutObject, etc.)');
      }

      // Check for overly broad resources
      const hasBroadResources = policy.Statement?.some((stmt: any) =>
        stmt.Resource === '*' ||
        (Array.isArray(stmt.Resource) && stmt.Resource.includes('*')) ||
        stmt.Resource === `arn:aws:s3:::*` ||
        stmt.Resource === `arn:aws:s3:::*/*`
      );

      if (hasBroadResources) {
        violations.push('Policy contains overly broad resources - violates least privilege');
        recommendations.push('Restrict resources to specific bucket ARNs and tenant-specific prefixes');
      }

      // Check for tenant isolation
      const hasTenantIsolation = policy.Statement?.some((stmt: any) =>
        stmt.Sid === 'DenyOtherTenants' || stmt.Condition?.StringNotLike
      );

      if (!hasTenantIsolation) {
        violations.push('Missing tenant isolation rules');
        recommendations.push('Add deny rules to prevent cross-tenant data access');
      }

      // Check for delete permissions
      const allowsDelete = policy.Statement?.some((stmt: any) =>
        stmt.Effect === 'Allow' && (
          stmt.Action === 's3:DeleteObject' ||
          (Array.isArray(stmt.Action) && stmt.Action.includes('s3:DeleteObject'))
        )
      );

      if (allowsDelete) {
        violations.push('Policy allows delete operations - processed images should be immutable');
        recommendations.push('Remove s3:DeleteObject permissions for processed images');
      }

    } catch (error) {
      violations.push('Invalid JSON policy document');
    }

    return {
      isValid: violations.length === 0,
      violations,
      recommendations,
    };
  }

  /**
   * Generate IAM policy for Lambda function
   */
  generateLambdaIAMPolicy(bucketName: string): any {
    return {
      Version: '2012-10-17',
      Statement: [
        // Read access for input images
        {
          Effect: 'Allow',
          Action: [
            's3:GetObject',
            's3:GetObjectVersion',
          ],
          Resource: `arn:aws:s3:::${bucketName}/input/*`,
        },
        // Write access for processed images (tenant-specific)
        {
          Effect: 'Allow',
          Action: [
            's3:PutObject',
            's3:PutObjectAcl',
          ],
          Resource: `arn:aws:s3:::${bucketName}/processed/${this.config.tenant}/*`,
        },
        // List access for tenant prefix
        {
          Effect: 'Allow',
          Action: 's3:ListBucket',
          Resource: `arn:aws:s3:::${bucketName}`,
          Condition: {
            StringLike: {
              's3:prefix': `${this.config.tenant}/*`,
            },
          },
        },
      ],
    };
  }

  /**
   * Analyze current permissions and provide optimization recommendations
   */
  async analyzePermissions(bucketName: string): Promise<{
    currentPolicy: string | null;
    validation: ReturnType<S3PermissionsManager['validateBucketPolicy']>;
    optimization: {
      canOptimize: boolean;
      estimatedSavings: string;
      riskLevel: 'low' | 'medium' | 'high';
    };
  }> {
    const currentPolicy = await this.getBucketPolicy(bucketName);
    const validation = currentPolicy
      ? this.validateBucketPolicy(currentPolicy)
      : { isValid: false, violations: ['No bucket policy found'], recommendations: ['Apply least-privilege bucket policy'] };

    // Estimate optimization potential
    const canOptimize = !validation.isValid;
    const violationCount = validation.violations.length;
    const estimatedSavings = violationCount > 2 ? '25-40%' : violationCount > 0 ? '10-25%' : '0%';
    const riskLevel = violationCount > 3 ? 'high' : violationCount > 1 ? 'medium' : 'low';

    return {
      currentPolicy,
      validation,
      optimization: {
        canOptimize,
        estimatedSavings,
        riskLevel,
      },
    };
  }
}