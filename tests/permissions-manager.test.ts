import { S3PermissionsManager } from '../src/lib/s3/permissions-manager';

// Mock AWS SDK
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn(),
  })),
  PutBucketPolicyCommand: jest.fn(),
  GetBucketPolicyCommand: jest.fn(),
  ListBucketsCommand: jest.fn(),
}));

describe('S3PermissionsManager', () => {
  let permissionsManager: S3PermissionsManager;
  let mockS3Client: any;

  beforeEach(() => {
    permissionsManager = new S3PermissionsManager({
      stage: 'test',
      tenant: 'test-tenant',
      region: 'eu-west-1',
      enableGranularPermissions: true,
    });

    const s3Client = require('@aws-sdk/client-s3').S3Client;
    mockS3Client = s3Client.mock.results[0].value;
  });

  describe('generateBucketPolicy', () => {
    it('should generate least-privilege bucket policy', () => {
      const policy = permissionsManager.generateBucketPolicy('test-bucket');

      const parsedPolicy = JSON.parse(policy);

      expect(parsedPolicy.Version).toBe('2012-10-17');
      expect(parsedPolicy.Statement).toHaveLength(5);

      // Check for tenant isolation deny rule
      const denyRule = parsedPolicy.Statement.find((stmt: any) => stmt.Sid === 'DenyOtherTenants');
      expect(denyRule).toBeDefined();
      expect(denyRule.Effect).toBe('Deny');

      // Check for delete denial
      const deleteDenyRule = parsedPolicy.Statement.find((stmt: any) => stmt.Sid === 'DenyDeleteOperations');
      expect(deleteDenyRule).toBeDefined();
      expect(deleteDenyRule.Effect).toBe('Deny');
    });

    it('should include tenant-specific resource restrictions', () => {
      const policy = permissionsManager.generateBucketPolicy('test-bucket');
      const parsedPolicy = JSON.parse(policy);

      // Find write access rule
      const writeRule = parsedPolicy.Statement.find((stmt: any) =>
        stmt.Sid === 'AllowWriteProcessedImages'
      );

      expect(writeRule.Resource).toContain('test-tenant/');
    });
  });

  describe('applyBucketPolicy', () => {
    it('should apply bucket policy successfully', async () => {
      mockS3Client.send.mockResolvedValue({});

      await expect(permissionsManager.applyBucketPolicy('test-bucket')).resolves.not.toThrow();

      // Verify send was called (AWS SDK commands don't expose input directly)
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it('should handle S3 errors gracefully', async () => {
      mockS3Client.send.mockRejectedValue(new Error('S3 access denied'));

      await expect(permissionsManager.applyBucketPolicy('test-bucket')).rejects.toThrow('Failed to apply bucket policy');
    });
  });

  describe('validateBucketPolicy', () => {
    it('should validate compliant policy as valid', () => {
      const validPolicy = permissionsManager.generateBucketPolicy('test-bucket');
      const validation = permissionsManager.validateBucketPolicy(validPolicy);

      expect(validation.isValid).toBe(true);
      expect(validation.violations).toHaveLength(0);
    });

    it('should detect wildcard permissions violations', () => {
      const invalidPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
        }],
      });

      const validation = permissionsManager.validateBucketPolicy(invalidPolicy);

      expect(validation.isValid).toBe(false);
      expect(validation.violations).toContain('Policy contains wildcard (*) actions - violates least privilege');
    });

    it('should detect missing tenant isolation', () => {
      const invalidPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::test-bucket/*',
        }],
      });

      const validation = permissionsManager.validateBucketPolicy(invalidPolicy);

      expect(validation.isValid).toBe(false);
      expect(validation.violations).toContain('Missing tenant isolation rules');
    });

    it('should provide actionable recommendations', () => {
      const invalidPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
        }],
      });

      const validation = permissionsManager.validateBucketPolicy(invalidPolicy);

      // Check for partial match since recommendation includes specific examples
      expect(validation.recommendations.some(r => r.includes('Replace wildcard actions'))).toBe(true);
    });
  });

  describe('generateLambdaIAMPolicy', () => {
    it('should generate IAM policy for Lambda function', () => {
      const policy = permissionsManager.generateLambdaIAMPolicy('test-bucket');

      expect(policy.Version).toBe('2012-10-17');
      expect(policy.Statement).toHaveLength(3);

      // Check read access
      const readStatement = policy.Statement.find((stmt: any) =>
        stmt.Action.includes('s3:GetObject')
      );
      expect(readStatement).toBeDefined();
      expect(readStatement.Resource).toContain('input/*');

      // Check write access
      const writeStatement = policy.Statement.find((stmt: any) =>
        stmt.Action.includes('s3:PutObject')
      );
      expect(writeStatement).toBeDefined();
      expect(writeStatement.Resource).toContain('test-tenant/');
    });
  });

  describe('analyzePermissions', () => {
    it('should analyze existing permissions and provide optimization recommendations', async () => {
      const mockPolicy = permissionsManager.generateBucketPolicy('test-bucket');
      mockS3Client.send.mockResolvedValue({ Policy: mockPolicy });

      const analysis = await permissionsManager.analyzePermissions('test-bucket');

      expect(analysis.currentPolicy).toBe(mockPolicy);
      expect(analysis.validation.isValid).toBe(true);
      expect(analysis.optimization.canOptimize).toBe(false);
      expect(analysis.optimization.estimatedSavings).toBe('0%');
      expect(analysis.optimization.riskLevel).toBe('low');
    });

    it('should detect optimization opportunities', async () => {
      const badPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: '*',
          Resource: '*',
        }],
      });

      mockS3Client.send.mockResolvedValue({ Policy: badPolicy });

      const analysis = await permissionsManager.analyzePermissions('test-bucket');

      expect(analysis.validation.isValid).toBe(false);
      expect(analysis.optimization.canOptimize).toBe(true);
      // Risk level is 'medium' for 2-3 violations (high requires > 3)
      expect(analysis.optimization.riskLevel).toBe('medium');
    });

    it('should handle missing bucket policy', async () => {
      const error = new Error('No such bucket policy');
      error.name = 'NoSuchBucketPolicy';
      mockS3Client.send.mockRejectedValue(error);

      const analysis = await permissionsManager.analyzePermissions('test-bucket');

      expect(analysis.currentPolicy).toBeNull();
      expect(analysis.validation.isValid).toBe(false);
      expect(analysis.validation.violations).toContain('No bucket policy found');
    });
  });
});