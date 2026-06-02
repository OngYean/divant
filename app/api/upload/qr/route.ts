import { NextResponse } from 'next/server';
import Jimp from 'jimp';
// @ts-expect-error - qrcode-reader does not have official type declarations
import QrCode from 'qrcode-reader';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    // Ensure request is multipart/form-data
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ ok: false, message: 'Content-Type must be multipart/form-data' }, { status: 400 });
    }
    // Parse the form data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, message: `Failed to parse form data: ${msg}` }, { status: 400 });
    }
    const fileObj = formData.get('qr');
    if (!fileObj || !(fileObj instanceof File)) {
      return NextResponse.json({ ok: false, message: 'Missing QR image file (field name "qr")' }, { status: 400 });
    }
    // Validate file type
    if (!fileObj.type?.startsWith('image/')) {
      return NextResponse.json({ ok: false, message: 'Uploaded file must be an image' }, { status: 400 });
    }
    // Read image into buffer for Jimp
    // Read image into buffer for Jimp
    const buffer = Buffer.from(await fileObj.arrayBuffer());
    const image = await Jimp.read(buffer);
    // Helper to decode QR from a bitmap
    const decodeFromBitmap = async (bitmap: any) => {
      return new Promise<string>((resolve, reject) => {
        const decoder = new QrCode();
        decoder.callback = (err: any, value: any) => {
          if (err) reject(err);
          else if (!value || !value.result) reject(new Error('No QR code result'));
          else resolve(value.result);
        };
        decoder.decode(bitmap);
      });
    };

    // Strategies for processing images to help qrcode-reader find the QR code
    // especially when it is small, low contrast, non-black, or inverted.
    const strategies = [
      // 1. Scale down to 800px (most common fix for high-res images with small QRs)
      {
        name: 'resize_800_grayscale_contrast_1',
        run: (img: Jimp) => img.clone().resize(800, Jimp.AUTO).grayscale().contrast(1)
      },
      {
        name: 'resize_800_grayscale_contrast_1_inverted',
        run: (img: Jimp) => img.clone().resize(800, Jimp.AUTO).grayscale().contrast(1).invert()
      },
      // 2. Scale down to 500px (smaller search grid)
      {
        name: 'resize_500_grayscale_contrast_1',
        run: (img: Jimp) => img.clone().resize(500, Jimp.AUTO).grayscale().contrast(1)
      },
      {
        name: 'resize_500_grayscale_contrast_1_inverted',
        run: (img: Jimp) => img.clone().resize(500, Jimp.AUTO).grayscale().contrast(1).invert()
      },
      // 3. Normal grayscale + contrast on original
      {
        name: 'original_grayscale_contrast_1',
        run: (img: Jimp) => img.clone().grayscale().contrast(1)
      },
      {
        name: 'original_grayscale_contrast_1_inverted',
        run: (img: Jimp) => img.clone().grayscale().contrast(1).invert()
      },
      // 4. Normalize first, to fix colored/faded QR codes
      {
        name: 'normalize_grayscale_contrast_1',
        run: (img: Jimp) => img.clone().normalize().grayscale().contrast(1)
      },
      {
        name: 'normalize_grayscale_contrast_1_inverted',
        run: (img: Jimp) => img.clone().normalize().grayscale().contrast(1).invert()
      },
      // 5. Lower contrast (so finder patterns don't merge or bleed)
      {
        name: 'resize_800_grayscale_contrast_05',
        run: (img: Jimp) => img.clone().resize(800, Jimp.AUTO).grayscale().contrast(0.5)
      },
      {
        name: 'resize_800_grayscale_contrast_05_inverted',
        run: (img: Jimp) => img.clone().resize(800, Jimp.AUTO).grayscale().contrast(0.5).invert()
      },
      // 6. Scale down to 1200px
      {
        name: 'resize_1200_grayscale_contrast_1',
        run: (img: Jimp) => img.clone().resize(1200, Jimp.AUTO).grayscale().contrast(1)
      },
      {
        name: 'resize_1200_grayscale_contrast_1_inverted',
        run: (img: Jimp) => img.clone().resize(1200, Jimp.AUTO).grayscale().contrast(1).invert()
      },
      // 7. Grayscale only
      {
        name: 'original_grayscale',
        run: (img: Jimp) => img.clone().grayscale()
      },
      {
        name: 'original_grayscale_inverted',
        run: (img: Jimp) => img.clone().grayscale().invert()
      },
      // 8. Raw image
      {
        name: 'raw_image',
        run: (img: Jimp) => img.clone()
      }
    ];

    let decoded: string | undefined;
    let lastError: any = null;

    for (const strategy of strategies) {
      try {
        const processed = await strategy.run(image);
        decoded = await decodeFromBitmap(processed.bitmap);
        if (decoded) {
          console.log(`QR decoding succeeded using strategy: ${strategy.name}`);
          break;
        }
      } catch (err) {
        lastError = err;
        console.log(`QR decoding failed for strategy ${strategy.name}:`, err instanceof Error ? err.message : err);
      }
    }

    if (!decoded && lastError) {
      throw lastError;
    }

    const url = decoded?.trim();
    if (!url) {
      return NextResponse.json({ ok: false, message: 'Invalid QR code content; must contain text' }, { status: 400 });
    }
    // Return the parsed URL
    return NextResponse.json({ ok: true, url }, { status: 200 });
  } catch (e) {
    // Log the error for debugging
    console.error('QR upload error:', e);
    const msg = e instanceof Error ? e.message : 'Failed to process QR upload';
    // Include stack trace in development for better debugging
    const detail = process.env.NODE_ENV !== 'production' && e instanceof Error ? e.stack : undefined;
    return NextResponse.json({ ok: false, message: msg, ...(detail && { detail }) }, { status: 500 });
  }
}
