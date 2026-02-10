/**
 * Tests for image MIME type validation using magic bytes
 */

import { ProcessRequestSchema, GroupImagesRequestSchema } from '../src/lib/types';

describe('Image MIME Type Validation', () => {
  describe('ProcessRequestSchema - imageBase64 validation', () => {
    test('should accept valid PNG base64', () => {
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
      const validPngBase64 = pngMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: validPngBase64,
      });

      expect(result.success).toBe(true);
    });

    test('should accept valid JPEG base64', () => {
      // JPEG magic bytes: FF D8 FF
      const jpegMagicBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const validJpegBase64 = jpegMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: validJpegBase64,
      });

      expect(result.success).toBe(true);
    });

    test('should accept valid WebP base64', () => {
      // WebP magic bytes: RIFF ... WEBP
      const webpMagicBytes = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // file size placeholder
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      const validWebPBase64 = webpMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: validWebPBase64,
      });

      expect(result.success).toBe(true);
    });

    test('should accept valid HEIC base64', () => {
      // HEIC magic bytes: ftyp at bytes 4-7
      const heicMagicBytes = Buffer.from([
        0x00, 0x00, 0x00, 0x20, // size placeholder
        0x66, 0x74, 0x79, 0x70, // ftyp
        0x68, 0x65, 0x69, 0x63, // heic
      ]);
      const validHeicBase64 = heicMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: validHeicBase64,
      });

      expect(result.success).toBe(true);
    });

    test('should reject invalid image format (PDF)', () => {
      // PDF magic bytes: 25 50 44 46 (=PDF)
      const pdfMagicBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);
      const pdfBase64 = pdfMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: pdfBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid image format');
      }
    });

    test('should reject invalid image format (ZIP)', () => {
      // ZIP magic bytes: 50 4B 03 04 or 50 4B 05 06
      const zipMagicBytes = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
      const zipBase64 = zipMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: zipBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid image format');
      }
    });

    test('should reject plain text as image', () => {
      const plainText = 'This is just plain text, not an image';
      const textBase64 = Buffer.from(plainText).toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: textBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid image format');
      }
    });

    test('should reject executable file (EXE)', () => {
      // EXE magic bytes: 4D 5A (MZ)
      const exeMagicBytes = Buffer.from([0x4D, 0x5A, 0x90, 0x00]);
      const exeBase64 = exeMagicBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: exeBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid image format');
      }
    });

    test('should reject base64 that exceeds 10MB limit', () => {
      // Create base64 > 10MB (10 * 1024 * 1024 chars)
      const largeString = 'A'.repeat(11 * 1024 * 1024);
      const largePngBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG header
        Buffer.from(largeString),
      ]);
      const largeBase64 = largePngBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: largeBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('too large');
      }
    });
  });

  describe('GroupImagesRequestSchema - image validation', () => {
    test('should accept array of valid PNG images', () => {
      const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const validPngBase64 = pngMagicBytes.toString('base64');

      const result = GroupImagesRequestSchema.safeParse({
        images: [
          { imageBase64: validPngBase64 },
          { imageBase64: validPngBase64 },
        ],
      });

      expect(result.success).toBe(true);
    });

    test('should reject array with invalid image format', () => {
      const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const pdfMagicBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);

      const result = GroupImagesRequestSchema.safeParse({
        images: [
          { imageBase64: pngMagicBytes.toString('base64') },
          { imageBase64: pdfMagicBytes.toString('base64') }, // Invalid
        ],
      });

      expect(result.success).toBe(false);
    });

    test('should enforce maximum 100 images per batch', () => {
      const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const validPngBase64 = pngMagicBytes.toString('base64');

      // Create 101 images
      const images = Array(101).fill(null).map(() => ({ imageBase64: validPngBase64 }));

      const result = GroupImagesRequestSchema.safeParse({ images });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Maximum 100 images');
      }
    });

    test('should require at least 1 image', () => {
      const result = GroupImagesRequestSchema.safeParse({
        images: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('At least 1 image is required for grouping');
      }
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty base64 string', () => {
      const result = ProcessRequestSchema.safeParse({
        imageBase64: '',
      });

      expect(result.success).toBe(false);
    });

    test('should handle very short base64 (less than 12 bytes)', () => {
      const shortBytes = Buffer.from([0xFF, 0xD8]); // Too short for JPEG
      const shortBase64 = shortBytes.toString('base64');

      const result = ProcessRequestSchema.safeParse({
        imageBase64: shortBase64,
      });

      expect(result.success).toBe(false);
    });

    test('should handle malformed base64', () => {
      const malformedBase64 = 'not-valid-base64!!!';

      const result = ProcessRequestSchema.safeParse({
        imageBase64: malformedBase64,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid base64 format');
      }
    });
  });
});
