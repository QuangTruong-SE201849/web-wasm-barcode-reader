/**
 * BarcodeScanner — wrapper-ready barcode scanning class.
 *
 * Manages the full lifecycle: DOM setup, camera stream, WASM loading,
 * scan loop with rotation-based skew correction, and cleanup.
 * Designed for easy integration into React/Vue/vanilla wrappers.
 *
 * Constructor is side-effect-free (React strict-mode safe).
 * Call start() to activate, stop() to tear down.
 */

import { createOverlay, removeOverlay } from './overlay';
import type { EmscriptenModule, ProcessResultCallback } from './types/emscripten';

// ── Public types ────────────────────────────────────────────────────

export interface ScannerOptions {
  /** Container element the scanner will mount into. */
  container: HTMLElement;
  /** Called on every successful barcode detection. */
  onDetect: (result: ScanResult) => void;
  /** Called on unrecoverable errors (camera denied, WASM load failure, etc.). */
  onError?: (error: Error) => void;
  /** Milliseconds between scan attempts. Default: 150. */
  scanInterval?: number;
  /** Play an audible beep on detection. Default: true. */
  beepOnDetect?: boolean;
  /** Camera facing mode. Default: 'environment'. */
  facingMode?: 'environment' | 'user';
  /**
   * Scan region as a fraction of the container dimensions.
   * Default: { width: 0.702, height: 0.242 } — matches the original barcode layout.
   */
  scanRegion?: { width: number; height: number };
  /**
   * Optional canvas to render a live preview of what each rotation pass
   * sees. Shows all three angles (0°, +30°, -30°) stacked vertically.
   * The detected angle gets a green highlight.
   */
  previewCanvas?: HTMLCanvasElement;
  /**
   * Resolution multiplier for the camera and offscreen canvas.
   * Higher values improve detection of small/dense barcodes at the cost
   * of more GPU scaling work. Default: 1.5.
   */
  resolutionScale?: number;
  /**
   * Base URL/path to the WASM assets (a.out.js and a.out.wasm).
   * When using the npm package, this defaults to the package's public/ directory
   * served from your dev server or CDN. Set this if you host the assets elsewhere.
   * Example: '/assets/wasm/' or 'https://cdn.example.com/wasm-barcode-reader/'
   */
  wasmPath?: string;
}

export interface ScanResult {
  /** Barcode symbology (e.g. "EAN-13", "QR-Code"). */
  symbol: string;
  /** Decoded barcode data string. */
  data: string;
  /** Flat polygon coordinates [x1,y1,x2,y2,...] in container-relative pixels. */
  polygon: number[];
}

// ── Internal helpers ────────────────────────────────────────────────

/** WASM API surface — direct function exports from Emscripten. */
interface WasmApi {
  scan_image_rgba: (ptr: number, width: number, height: number) => number;
  create_buffer: (width: number, height: number) => number;
  destroy_buffer: (ptr: number) => void;
  destroy_scanner?: () => void;
}

/** Base64-encoded short beep sound — avoids an external audio file. */
const BEEP_DATA_URI =
  'data:audio/wav;base64,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qJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=';

/**
 * Rotation angles for skew correction.
 * We try 0° first; if no barcode is found, we retry at ±30°.
 * This handles tilted barcodes without requiring the user to perfectly align.
 */
const ROTATION_ANGLES = [0, Math.PI / 6, -Math.PI / 6];

/**
 * Xoay dữ liệu pixel RGBA mức byte từ srcData và copy trực tiếp vào WASM HEAPU8 tại dstPtr.
 * Sử dụng thuật toán xoay ngược (inverse mapping) quanh tâm của vùng quét.
 * Giúp triệt tiêu hoàn toàn việc gọi getImageData và tạo canvas transform nhiều lần.
 */
function rotateAndCopy(
  srcData: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  angle: number,
  dstHeap: Uint8Array,
  dstPtr: number
): void {
  if (angle === 0) {
    dstHeap.set(srcData, dstPtr);
    return;
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = srcW / 2;
  const cy = srcH / 2;

  // Lấp đầy vùng đệm đích bằng màu trắng (255) làm nền sạch cho ZBar
  dstHeap.fill(255, dstPtr, dstPtr + srcW * srcH * 4);

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const rx = Math.round((x - cx) * cos + (y - cy) * sin + cx);
      const ry = Math.round(-(x - cx) * sin + (y - cy) * cos + cy);

      if (rx >= 0 && rx < srcW && ry >= 0 && ry < srcH) {
        const srcIdx = (ry * srcW + rx) * 4;
        const dstIdx = dstPtr + (y * srcW + x) * 4;

        dstHeap[dstIdx]     = srcData[srcIdx];
        dstHeap[dstIdx + 1] = srcData[srcIdx + 1];
        dstHeap[dstIdx + 2] = srcData[srcIdx + 2];
        dstHeap[dstIdx + 3] = srcData[srcIdx + 3];
      }
    }
  }
}

// ── BarcodeScanner ──────────────────────────────────────────────────

export class BarcodeScanner {
  // Configuration (immutable after construction)
  private readonly container: HTMLElement;
  private readonly onDetect: (result: ScanResult) => void;
  private readonly onError: (error: Error) => void;
  private readonly scanInterval: number;
  private readonly beepOnDetect: boolean;
  private readonly facingMode: 'environment' | 'user';
  private readonly regionWidth: number;
  private readonly regionHeight: number;
  private readonly resolutionScale: number;
  private readonly wasmPath: string;

  // Runtime state
  private _isRunning = false;
  private starting = false;
  private lifecycle = 0;
  private video: HTMLVideoElement | null = null;
  private polyCanvas: HTMLCanvasElement | null = null;
  private polyCtx: CanvasRenderingContext2D | null = null;
  private offscreen: OffscreenCanvas | HTMLCanvasElement | null = null;
  private offCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private overlayRoot: HTMLElement | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private lastScanTime = 0;
  private wasmApi: WasmApi | null = null;
  private beepAudio: HTMLAudioElement | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewCtx: CanvasRenderingContext2D | null = null;

  // Cached layout values (set during setupDOM)
  private cameraWidth = 0;
  private cameraHeight = 0;
  private barcodeWidth = 0;
  private barcodeHeight = 0;
  private barcodeOffsetX = 0;
  private barcodeOffsetY = 0;

  /** Tracks whether we detected a barcode in the current scan tick. */
  private detectedThisTick = false;
  /** Whether the previous tick had a detection (used to avoid unnecessary clearRect). */
  private hadDetectionLastTick = false;

  // Pre-allocated buffers to reduce per-tick GC pressure
  private polyScaleX = 0;
  private polyScaleY = 0;
  private scratchPoly: number[] = [];
  /** Reusable WASM heap pointer for RGBA scan data — allocated once at init. */
  private wasmBufferPtr = 0;

  /** Góc xoay hiện tại của khung hình quét dùng để xoay ngược tọa độ polygon. */
  private currentScanAngle = 0;
  /** Nội dung mã vạch quét được gần nhất dùng cho throttling. */
  private lastScannedData: string | null = null;
  /** Thời gian quét mã vạch gần nhất dùng cho throttling. */
  private lastScannedTime = 0;

  // Thuộc tính theo dõi trạng thái crop ngang tạm thời để điều hướng tọa độ polygon vẽ khung đỏ
  private currentCropFactor = 1.0;
  private currentCropX = 0;


  get isRunning(): boolean {
    return this._isRunning;
  }

  constructor(options: ScannerOptions) {
    this.container = options.container;
    this.onDetect = options.onDetect;
    this.onError = options.onError ?? ((e: Error) => console.error('[BarcodeScanner]', e));
    this.scanInterval = options.scanInterval ?? 150;
    this.beepOnDetect = options.beepOnDetect ?? true;
    this.facingMode = options.facingMode ?? 'environment';
    this.regionWidth = options.scanRegion?.width ?? 0.702;
    this.regionHeight = options.scanRegion?.height ?? 0.242;
    this.resolutionScale = options.resolutionScale ?? 1.5;
    this.previewCanvas = options.previewCanvas ?? null;
    this.wasmPath = options.wasmPath ?? '';
  }

  // ── Public lifecycle ────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._isRunning || this.starting) return;
    const lifecycle = ++this.lifecycle;
    this.starting = true;

    try {
      this.setupDOM();
      await this.loadWasm();
      if (lifecycle !== this.lifecycle) return;
      await this.startCamera();
      if (lifecycle !== this.lifecycle) return;
      this.setupResultHandler();
      this.startScanLoop();
      this._isRunning = true;
    } catch (err) {
      // Closing/reopening the sheet invalidates old permission/play results.
      // An old rejection must not tear down the new scanner or report an error.
      if (lifecycle !== this.lifecycle) return;
      this.stop();
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError(error);
    } finally {
      if (lifecycle === this.lifecycle) this.starting = false;
    }
  }

  stop(): void {
    ++this.lifecycle;
    this.starting = false;
    this.stopScanLoop();
    this.stopCamera();
    this.teardownDOM();
    if (this.wasmBufferPtr && this.wasmApi) {
      this.wasmApi.destroy_buffer(this.wasmBufferPtr);
      this.wasmBufferPtr = 0;
    }
    this.wasmApi?.destroy_scanner?.();
    this._isRunning = false;
  }

  /**
   * Toggle the device torch (flashlight). Returns the new torch state.
   * Only works on devices that support the torch constraint (most Android phones).
   */
  async toggleTorch(): Promise<boolean> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return false;

    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    if (!capabilities.torch) return false;

    const settings = track.getSettings() as MediaTrackSettings & { torch?: boolean };
    const newState = !settings.torch;

    await track.applyConstraints({
      advanced: [{ torch: newState } as MediaTrackConstraintSet],
    });

    return newState;
  }

  // ── DOM setup / teardown ────────────────────────────────────────

  private setupDOM(): void {
    // Ensure the container is positioned so absolute children work correctly.
    const pos = getComputedStyle(this.container).position;
    if (pos === 'static') {
      this.container.style.position = 'relative';
    }

    this.cameraWidth = this.container.clientWidth;
    this.cameraHeight = this.container.clientHeight;
    if (this.cameraWidth === 0 || this.cameraHeight === 0) {
      throw new Error('Container has zero size. Ensure it is visible and has explicit width/height before calling start().');
    }
    this.barcodeWidth = Math.floor(this.cameraWidth * this.regionWidth);
    this.barcodeHeight = Math.floor(this.cameraHeight * this.regionHeight);
    this.barcodeOffsetX = Math.floor((this.cameraWidth - this.barcodeWidth) / 2);
    this.barcodeOffsetY = Math.floor((this.cameraHeight - this.barcodeHeight) / 2);

    // Video element — fills the container
    this.video = document.createElement('video');
    Object.assign(this.video.style, {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
    });
    this.video.setAttribute('autoplay', '');
    this.video.setAttribute('muted', '');
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    // Property must also be set — attribute alone doesn't satisfy autoplay policy.
    this.video.muted = true;
    this.video.playsInline = true;
    this.container.appendChild(this.video);

    // Canvas for drawing polygon overlays on detected barcodes
    this.polyCanvas = document.createElement('canvas');
    this.polyCanvas.width = this.cameraWidth;
    this.polyCanvas.height = this.cameraHeight;
    Object.assign(this.polyCanvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
    });
    this.container.appendChild(this.polyCanvas);
    this.polyCtx = this.polyCanvas.getContext('2d');
    if (!this.polyCtx) throw new Error('Failed to get 2D context for polygon overlay canvas.');

    // Offscreen canvas for pixel extraction — scaled up for sharper image.
    // Fall back to a hidden HTMLCanvasElement when OffscreenCanvas is unavailable
    // (e.g. Safari < 16.4).
    const ow = Math.round(this.barcodeWidth * this.resolutionScale);
    const oh = Math.round(this.barcodeHeight * this.resolutionScale);
    if (typeof OffscreenCanvas !== 'undefined') {
      this.offscreen = new OffscreenCanvas(ow, oh);
    } else {
      const c = document.createElement('canvas');
      c.width = ow;
      c.height = oh;
      this.offscreen = c;
    }
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true });
    if (!this.offCtx) throw new Error('Failed to get 2D context for offscreen canvas.');

    // Cache polygon scale factors — constant for the scanner's lifetime.
    this.polyScaleX = this.barcodeWidth / this.offscreen.width;
    this.polyScaleY = this.barcodeHeight / this.offscreen.height;

    // CSS overlay (mask + brackets + laser)
    this.overlayRoot = createOverlay(this.container, {
      widthRatio: this.regionWidth,
      heightRatio: this.regionHeight,
    });

    // Beep audio
    if (this.beepOnDetect) {
      this.beepAudio = new Audio(BEEP_DATA_URI);
    }

    // Preview canvas — size it to fit three stacked rotation frames.
    if (this.previewCanvas) {
      this.previewCanvas.width = Math.round(this.barcodeWidth * this.resolutionScale);
      this.previewCanvas.height = Math.round(this.barcodeHeight * this.resolutionScale) * ROTATION_ANGLES.length;
      this.previewCtx = this.previewCanvas.getContext('2d');
    }
  }

  private teardownDOM(): void {
    if (this.overlayRoot) {
      removeOverlay(this.overlayRoot);
      this.overlayRoot = null;
    }
    this.video?.remove();
    this.video = null;
    this.polyCanvas?.remove();
    this.polyCanvas = null;
    this.polyCtx = null;
    this.offscreen = null;
    this.offCtx = null;
    this.beepAudio = null;
    this.previewCtx = null;
  }

  // ── WASM loading ────────────────────────────────────────────────

  /**
   * Resolve the base URL for WASM assets.
   * Tries in order: user-provided wasmPath, then Vite dev server plugin path, then npm package path.
   */
  private resolveWasmBaseUrl(): string {
    if (this.wasmPath) return this.wasmPath;
    // When running under Vite dev server with wasmBarcodeReaderPlugin(),
    // the plugin serves files at /@wasm-barcode-reader/
    return '/@wasm-barcode-reader/';
  }

  /**
   * Dynamically load the Emscripten glue script if not already present.
   * Sets Module.locateFile so the .wasm binary is fetched from the correct path.
   */
  private ensureWasmScriptLoaded(): Promise<void> {
    if (typeof Module !== 'undefined') return Promise.resolve();

    const wasmBaseUrl = this.resolveWasmBaseUrl();
    if (!wasmBaseUrl) {
      return Promise.reject(new Error(
        'WASM assets not found. Set the wasmPath option to the URL where a.out.js and a.out.wasm are served.',
      ));
    }

    return new Promise<void>((resolve, reject) => {
      // Define Module before loading the glue script so locateFile works
      (globalThis as Record<string, unknown>).Module = {
        locateFile: (path: string, _scriptDirectory: string): string => {
          return wasmBaseUrl + path;
        },
      };

      const script = document.createElement('script');
      script.src = wasmBaseUrl + 'a.out.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(
        `Failed to load WASM glue script from ${wasmBaseUrl}a.out.js. Set wasmPath option if assets are hosted elsewhere.`,
      ));
      document.head.appendChild(script);
    });
  }

  /**
   * Wait for the Emscripten Module to finish initializing.
   * Auto-loads the glue script if not already present.
   */
  private loadWasm(): Promise<void> {
    return this.ensureWasmScriptLoaded().then(() => {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WASM load timeout')), 15_000);

        const init = (): void => {
          clearTimeout(timeout);
          try {
            if (!Module._scan_image_rgba) throw new Error('WASM exports not available after runtime init');

            // Bind direct WASM exports — avoids cwrap's argument validation overhead.
            this.wasmApi = {
              scan_image_rgba: Module._scan_image_rgba.bind(Module),
              create_buffer: Module._create_buffer.bind(Module),
              destroy_buffer: Module._destroy_buffer.bind(Module),
            };
            // destroy_scanner is only available after recompiling the WASM binary.
            if (Module._destroy_scanner) {
              this.wasmApi.destroy_scanner = Module._destroy_scanner.bind(Module);
            }

            // Pre-allocate a reusable WASM buffer for RGBA scan data.
            // Dimensions are set during setupDOM() which runs before loadWasm().
            if (this.offscreen) {
              this.wasmBufferPtr = this.wasmApi.create_buffer(this.offscreen.width, this.offscreen.height);
              if (this.wasmBufferPtr === 0) throw new Error('Failed to allocate WASM scan buffer');
            }

            resolve();
          } catch (e) {
            reject(e);
          }
        };

        // If runtime already initialized (e.g. Module loaded before our code ran)
        if (Module.calledRun) {
          init();
        } else {
          const prev = Module.onRuntimeInitialized;
          Module.onRuntimeInitialized = () => {
            prev?.();
            init();
          };
        }
      });
    });
  }

  // ── Camera ──────────────────────────────────────────────────────

  private async startCamera(): Promise<void> {
    const video = this.video;
    const lifecycle = this.lifecycle;
    if (!video) throw new Error('DOM not set up');

    // Sử dụng cấu hình camera tối ưu 1280x720 cho iOS để tránh bị mờ tiêu cự
    const constraints: MediaStreamConstraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: { ideal: this.facingMode },
      } as MediaTrackConstraints,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (lifecycle !== this.lifecycle || this.video !== video) {
      // Permission may finish after stop() removed the video. Release the
      // returned stream without attaching it or replacing a newer camera.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    video.srcObject = stream;
    await video.play();
  }

  private stopCamera(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  // ── Result handler ──────────────────────────────────────────────

  /**
   * Wire up Module.processResult so the WASM-side library.js callback
   * routes detected barcodes back into our class.
   */
  private setupResultHandler(): void {
    const handler: ProcessResultCallback = (symbol, data, polygon) => {
      if (!data) return;

      // Cơ chế Throttling ngăn chặn spam kết quả trùng lặp của cùng một mã vạch trong 2 giây
      const now = Date.now();
      if (data === this.lastScannedData && now - this.lastScannedTime < 2000) {
        return;
      }
      this.lastScannedData = data;
      this.lastScannedTime = now;

      this.detectedThisTick = true;

      // Xoay ngược tọa độ polygon từ hệ tọa độ xoay về hệ tọa độ gốc (0°)
      const angle = this.currentScanAngle;
      const w = this.offscreen!.width;
      const h = this.offscreen!.height;
      const cx = w / 2;
      const cy = h / 2;
      const cos = Math.cos(-angle);
      const sin = Math.sin(-angle);

      const rotatedPoly: number[] = [];
      for (let i = 0; i < polygon.length; i += 2) {
        const px = polygon[i];
        const py = polygon[i + 1];
        const rx = (px - cx) * cos - (py - cy) * sin + cx;
        const ry = (px - cx) * sin + (py - cy) * cos + cy;
        rotatedPoly.push(rx, ry);
      }

      // Convert polygon from offscreen-canvas coords (taking crop into account) to container coords
      const sp = this.scratchPoly;
      sp.length = rotatedPoly.length;
      const cropX = this.currentCropX;
      const cropF = this.currentCropFactor;
      
      for (let i = 0; i < rotatedPoly.length; i += 2) {
        // Ánh xạ ngược từ canvas bị co giãn (crop) về canvas gốc
        const origCanvasX = cropX + rotatedPoly[i] * cropF;
        const origCanvasY = rotatedPoly[i + 1]; // Không crop dọc nên Y giữ nguyên
        
        sp[i] = origCanvasX * this.polyScaleX + this.barcodeOffsetX;
        sp[i + 1] = origCanvasY * this.polyScaleY + this.barcodeOffsetY;
      }


      // Draw detection polygon on the overlay canvas
      this.drawPoly(sp);

      // Audible feedback
      if (this.beepOnDetect && this.beepAudio) {
        this.beepAudio.play().catch(() => {
          /* autoplay policy may block — non-critical */
        });
      }

      const result: ScanResult = { symbol, data, polygon: sp.slice() };
      this.onDetect(result);
    };

    (Module as EmscriptenModule).processResult = handler;
  }

  // ── Scan loop ───────────────────────────────────────────────────

  private startScanLoop(): void {
    const loop = (now: number): void => {
      if (now - this.lastScanTime >= this.scanInterval) {
        this.scanTick();
        this.lastScanTime = now;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopScanLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * One scan tick: capture the barcode region, convert to grayscale,
   * and run through WASM. Uses rotation-based skew correction —
   * tries 0° first, then ±30° only if no barcode was found.
   */
  private scanTick(): void {
    if (!this.video || !this.offCtx || !this.offscreen || !this.wasmApi || !this.polyCtx) return;

    const videoW = this.video.videoWidth;
    const videoH = this.video.videoHeight;
    if (videoW === 0 || videoH === 0) return;

    const containerW = this.cameraWidth;
    const containerH = this.cameraHeight;

    // Phát hiện nếu luồng video bị xoay (ví dụ: video ngang 1280x720 hiển thị dọc 390x600 trên mobile Safari)
    const isRotated = videoW > videoH && containerW < containerH;

    if (this.hadDetectionLastTick) {
      this.polyCtx.clearRect(0, 0, this.cameraWidth, this.cameraHeight);
    }

    const w = this.offscreen.width;
    const h = this.offscreen.height;

    if (this.previewCtx && this.previewCanvas) {
      this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    }

    let imageData: ImageData | null = null;
    let fullImageData: ImageData | null = null;

    try {
      // 1. Quét Full Frame
      // Vẽ video camera lên canvas phụ (áp dụng xoay nếu luồng camera bị xoay 90 độ)
      if (isRotated) {
        this.offCtx.save();
        this.offCtx.translate(w / 2, h / 2);
        this.offCtx.rotate(Math.PI / 2); // Xoay 90 độ theo chiều kim đồng hồ
        
        // Tính toán tỉ lệ cover dựa trên kích thước thực tế sau khi xoay (videoH là chiều ngang mới, videoW là chiều dọc mới)
        const scale = Math.max(containerW / videoH, containerH / videoW);
        const drawW = videoW * scale;
        const drawH = videoH * scale;
        
        // Tính độ dời của vùng barcode so với tâm container
        const dx = (this.barcodeOffsetX + this.barcodeWidth / 2) - (containerW / 2);
        const dy = (this.barcodeOffsetY + this.barcodeHeight / 2) - (containerH / 2);
        
        // Trong hệ tọa độ xoay 90 độ: độ lệch dx (ngang) map vào Y mới, dy (dọc) map vào -X mới
        this.offCtx.translate(-dy * scale, dx * scale);
        this.offCtx.drawImage(this.video, 0, 0, videoW, videoH, -drawW / 2, -drawH / 2, drawW, drawH);
        this.offCtx.restore();
      } else {
        this.offCtx.save();
        const scale = Math.max(containerW / videoW, containerH / videoH);
        const drawW = videoW * scale;
        const drawH = videoH * scale;
        
        const dx = (this.barcodeOffsetX + this.barcodeWidth / 2) - (containerW / 2);
        const dy = (this.barcodeOffsetY + this.barcodeHeight / 2) - (containerH / 2);
        
        this.offCtx.translate(w / 2 - dx * scale, h / 2 - dy * scale);
        this.offCtx.drawImage(this.video, 0, 0, videoW, videoH, -drawW / 2, -drawH / 2, drawW, drawH);
        this.offCtx.restore();
      }

      fullImageData = this.offCtx.getImageData(0, 0, w, h);
      imageData = fullImageData;

      // Đặt mặc định trạng thái không crop để setupResultHandler hoạt động bình thường
      this.currentCropFactor = 1.0;
      this.currentCropX = 0;

      for (let ai = 0; ai < ROTATION_ANGLES.length; ai++) {
        const angle = ROTATION_ANGLES[ai];
        this.detectedThisTick = false;
        this.currentScanAngle = angle;

        rotateAndCopy(imageData.data, w, h, angle, Module.HEAPU8, this.wasmBufferPtr);
        this.wasmApi.scan_image_rgba(this.wasmBufferPtr, w, h);
        if (this.detectedThisTick) break;
      }

      // 2. Nếu quét Full không ra, thử các mức crop ngang tịnh tiến (90%, 80%, 70%) ở góc 0°
      // để tự động cắt bỏ viền đen bao quanh barcode (giải quyết lỗi Quiet Zone)
      if (!this.detectedThisTick) {
        const CROP_LEVELS = [0.90, 0.80, 0.70];
        for (const crop of CROP_LEVELS) {
          const cropW = w * crop;
          const cropX = (w - cropW) / 2;

          this.currentCropFactor = crop;
          this.currentCropX = cropX;

          // Khôi phục canvas gốc và crop trên canvas
          this.offCtx.putImageData(fullImageData, 0, 0);
          this.offCtx.drawImage(
            this.offscreen,
            cropX, 0, cropW, h,
            0, 0, w, h,
          );
          
          imageData = this.offCtx.getImageData(0, 0, w, h);
          this.currentScanAngle = 0;

          rotateAndCopy(imageData.data, w, h, 0, Module.HEAPU8, this.wasmBufferPtr);
          this.wasmApi.scan_image_rgba(this.wasmBufferPtr, w, h);

          if (this.detectedThisTick) {
            break;
          }
        }
      }

    } finally {
      this.hadDetectionLastTick = this.detectedThisTick;
      imageData = null;
      fullImageData = null;
    }
  }


  // ── Drawing ─────────────────────────────────────────────────────

  /** Draw a polygon outline on the overlay canvas. */
  private drawPoly(coords: number[]): void {
    if (!this.polyCtx || coords.length < 4) return;

    this.polyCtx.beginPath();
    this.polyCtx.moveTo(coords[0], coords[1]);

    for (let i = 2; i < coords.length; i += 2) {
      this.polyCtx.lineTo(coords[i], coords[i + 1]);
    }

    this.polyCtx.closePath();
    this.polyCtx.lineWidth = 2;
    this.polyCtx.strokeStyle = '#FF0000';
    this.polyCtx.stroke();
  }

}
