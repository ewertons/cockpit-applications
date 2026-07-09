// Ambient type declaration for the `qrcode-generator` package, which ships as
// plain JavaScript without bundled TypeScript definitions.
declare module 'qrcode-generator' {
    interface QRCode {
        addData(data: string, mode?: string): void;
        make(): void;
        getModuleCount(): number;
        isDark(row: number, col: number): boolean;
        createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
        createDataURL(cellSize?: number, margin?: number): string;
    }

    type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

    function qrcode(typeNumber: number, errorCorrectionLevel: ErrorCorrectionLevel): QRCode;

    export = qrcode;
}
