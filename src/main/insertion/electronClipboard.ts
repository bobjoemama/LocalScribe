import { clipboard, nativeImage } from "electron";
import type { ClipboardPort, ClipboardSnapshot } from "./types";

const PLAIN_TEXT_FORMATS = [
  /^text\/plain/i,
  /^public\.(?:utf8|utf16|plain-text)/i,
  /unicode.*text/i,
  /^string$/i,
];
const HTML_FORMATS = [/^text\/html/i, /^public\.html$/i, /^html format$/i];
const RTF_FORMATS = [/^text\/rtf/i, /^public\.rtf$/i, /rich text format/i];
const IMAGE_FORMATS = [
  /^image\//i,
  /^public\.(?:png|tiff|jpeg)$/i,
  /^com\.apple\.pict$/i,
  /^cf_(?:dib|dibv5)$/i,
];
function hasMatchingFormat(formats: readonly string[], patterns: readonly RegExp[]): boolean {
  return formats.some((format) => patterns.some((pattern) => pattern.test(format)));
}

function isRestorableFormat(format: string): boolean {
  return [PLAIN_TEXT_FORMATS, HTML_FORMATS, RTF_FORMATS, IMAGE_FORMATS]
    .flat()
    .some((pattern) => pattern.test(format));
}

export class ElectronClipboardPort implements ClipboardPort {
  snapshot(): ClipboardSnapshot {
    const formats = clipboard.availableFormats();
    const snapshot: ClipboardSnapshot = {
      restorable: formats.every(isRestorableFormat),
    };

    if (hasMatchingFormat(formats, PLAIN_TEXT_FORMATS)) snapshot.text = clipboard.readText();
    if (hasMatchingFormat(formats, HTML_FORMATS)) snapshot.html = clipboard.readHTML();
    if (hasMatchingFormat(formats, RTF_FORMATS)) snapshot.rtf = clipboard.readRTF();
    if (hasMatchingFormat(formats, IMAGE_FORMATS)) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) snapshot.imagePng = image.toPNG();
    }
    return snapshot;
  }

  writeText(text: string): void {
    clipboard.writeText(text);
  }

  restore(snapshot: ClipboardSnapshot): void {
    if (!snapshot.restorable) return;
    const data: Parameters<typeof clipboard.write>[0] = {};
    if (snapshot.text !== undefined) data.text = snapshot.text;
    if (snapshot.html !== undefined) data.html = snapshot.html;
    if (snapshot.rtf !== undefined) data.rtf = snapshot.rtf;
    if (snapshot.imagePng !== undefined) {
      data.image = nativeImage.createFromBuffer(Buffer.from(snapshot.imagePng));
    }

    if (Object.keys(data).length === 0) clipboard.clear();
    else clipboard.write(data);
  }
}

export const clipboardFormatMatchers = {
  hasMatchingFormat,
  isRestorableFormat,
};
