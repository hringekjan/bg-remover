import { uploadProcessedImage } from '../lib/s3/client';

describe('uploadProcessedImage', () => {
  it('should upload image to S3 successfully', async () => {
    const bucket = 'test-bucket';
    const key = 'test-image.jpg';
    const body = Buffer.from('test image content');

    await expect(uploadProcessedImage(bucket, key, body)).resolves.not.toThrow();
  });

  it('should throw an error if upload fails', async () => {
    const bucket = 'invalid-bucket';
    const key = 'test-image.jpg';
    const body = Buffer.from('test image content');

    await expect(uploadProcessedImage(bucket, key, body)).rejects.toThrow();
  });
});