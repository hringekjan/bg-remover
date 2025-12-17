'use client';

import { useState, useCallback } from 'react';

interface ProcessResult {
  success: boolean;
  jobId: string;
  outputUrl?: string;
  error?: string;
  processingTimeMs: number;
  metadata?: {
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
  };
}

export default function Home() {
  const [imageUrl, setImageUrl] = useState('');
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleProcess = useCallback(async () => {
    if (!imageUrl) {
      setError('Please enter an image URL');
      return;
    }

    setProcessing(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageUrl,
          outputFormat: 'png',
          quality: 95,
          tenant: 'carousel-labs',
        }),
      });

      const data = await response.json();

      if (data.success) {
        setResult(data);
      } else {
        setError(data.error || 'Processing failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setProcessing(false);
    }
  }, [imageUrl]);

  return (
    <div style={{
      maxWidth: '800px',
      margin: '0 auto',
      padding: '40px 20px',
    }}>
      <header style={{ marginBottom: '40px', textAlign: 'center' }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          color: '#1a1a1a',
          marginBottom: '10px',
        }}>
          BG-Remover
        </h1>
        <p style={{
          fontSize: '1.1rem',
          color: '#666',
        }}>
          AI-powered background removal using AWS Bedrock Claude Vision
        </p>
      </header>

      <main>
        <div style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          padding: '30px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
          marginBottom: '30px',
        }}>
          <label style={{
            display: 'block',
            marginBottom: '10px',
            fontWeight: 600,
            color: '#333',
          }}>
            Image URL
          </label>
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/image.jpg"
            disabled={processing}
            style={{
              width: '100%',
              padding: '12px 16px',
              fontSize: '16px',
              border: '2px solid #e0e0e0',
              borderRadius: '8px',
              outline: 'none',
              transition: 'border-color 0.2s',
              boxSizing: 'border-box',
            }}
          />

          <button
            onClick={handleProcess}
            disabled={processing || !imageUrl}
            style={{
              width: '100%',
              marginTop: '20px',
              padding: '14px 24px',
              fontSize: '16px',
              fontWeight: 600,
              color: 'white',
              backgroundColor: processing ? '#999' : '#0070f3',
              border: 'none',
              borderRadius: '8px',
              cursor: processing ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            {processing ? 'Processing...' : 'Remove Background'}
          </button>
        </div>

        {error && (
          <div style={{
            backgroundColor: '#fee2e2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '20px',
            color: '#dc2626',
          }}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {result && result.success && (
          <div style={{
            backgroundColor: 'white',
            borderRadius: '12px',
            padding: '30px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
          }}>
            <h2 style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              color: '#1a1a1a',
              marginBottom: '20px',
            }}>
              Result
            </h2>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '20px',
              marginBottom: '20px',
            }}>
              <div>
                <h3 style={{ fontSize: '1rem', color: '#666', marginBottom: '10px' }}>
                  Original
                </h3>
                <img
                  src={imageUrl}
                  alt="Original"
                  style={{
                    width: '100%',
                    borderRadius: '8px',
                    border: '1px solid #e0e0e0',
                  }}
                />
              </div>
              <div>
                <h3 style={{ fontSize: '1rem', color: '#666', marginBottom: '10px' }}>
                  Processed
                </h3>
                <img
                  src={result.outputUrl}
                  alt="Processed"
                  style={{
                    width: '100%',
                    borderRadius: '8px',
                    border: '1px solid #e0e0e0',
                    backgroundColor: '#f0f0f0',
                  }}
                />
              </div>
            </div>

            <div style={{
              backgroundColor: '#f5f5f5',
              borderRadius: '8px',
              padding: '16px',
            }}>
              <h3 style={{ fontSize: '1rem', color: '#666', marginBottom: '10px' }}>
                Processing Details
              </h3>
              <ul style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                fontSize: '14px',
                color: '#333',
              }}>
                <li style={{ marginBottom: '8px' }}>
                  <strong>Job ID:</strong> {result.jobId}
                </li>
                <li style={{ marginBottom: '8px' }}>
                  <strong>Processing Time:</strong> {result.processingTimeMs}ms
                </li>
                {result.metadata && (
                  <>
                    <li style={{ marginBottom: '8px' }}>
                      <strong>Dimensions:</strong> {result.metadata.width} x {result.metadata.height}
                    </li>
                    <li style={{ marginBottom: '8px' }}>
                      <strong>Original Size:</strong> {(result.metadata.originalSize / 1024).toFixed(1)} KB
                    </li>
                    <li>
                      <strong>Processed Size:</strong> {(result.metadata.processedSize / 1024).toFixed(1)} KB
                    </li>
                  </>
                )}
              </ul>
            </div>

            <a
              href={result.outputUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-block',
                marginTop: '20px',
                padding: '12px 24px',
                fontSize: '14px',
                fontWeight: 600,
                color: 'white',
                backgroundColor: '#10b981',
                borderRadius: '8px',
                textDecoration: 'none',
              }}
            >
              Download Processed Image
            </a>
          </div>
        )}
      </main>

      <footer style={{
        marginTop: '60px',
        textAlign: 'center',
        color: '#999',
        fontSize: '14px',
      }}>
        <p>CarouselLabs BG-Remover Service</p>
        <p>Powered by AWS Bedrock Claude 3.5 Sonnet Vision</p>
      </footer>
    </div>
  );
}
