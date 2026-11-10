// @ts-nocheck
import { uploadFetch } from "../../../../../runtime-context";
/*
 * Adapted from jackwener/opencli commit 0e73c3c2c2b45c91e050e1618b20e2aba22f1a23.
 * Licensed under Apache-2.0. Modified for AutoUp module imports and TypeScript compilation.
 */
// @ts-nocheck
/**
 * ImageX cover image uploader.
 *
 * Uses the creator center's signed ImageX apply, upload and commit flow.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CommandExecutionError } from "../../../opencli-shim/errors.js";
import { crc32Hex } from "./tos-upload.js";
import { computeAws4Headers } from "./vod-upload.js";

// The cover service from the creator center uploader's imageConfig.
const COVER_SERVICE_ID = "jm8ajry58r";

async function imagexRequest(action, credentials, query, body?) {
  const params = new URLSearchParams({
    Action: action,
    Version: "2018-08-01",
    ServiceId: COVER_SERVICE_ID,
    ...query,
  });
  const url = `https://imagex.bytedanceapi.com/?${params}`;
  const method = body === undefined ? "GET" : "POST";
  const res = await uploadFetch(url, {
    method,
    body,
    headers: computeAws4Headers(url, credentials, {
      method,
      body,
      service: "imagex",
      headers: body === undefined ? {} : { "content-type": "application/json" },
    }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || payload?.ResponseMetadata?.Error || !payload?.Result) {
    throw new CommandExecutionError(
      `ImageX ${action} 失败 (HTTP ${res.status})`,
    );
  }
  return payload.Result;
}

export async function applyImageUpload(credentials, fileExtension) {
  const result = await imagexRequest("ApplyImageUpload", credentials, {
    UploadNum: "1",
    FileExtension: fileExtension,
  });
  const address = result.UploadAddress;
  const host = address?.UploadHosts?.[0];
  const store = address?.StoreInfos?.[0];
  if (!host || !store?.StoreUri || !store?.Auth || !address.SessionKey) {
    throw new CommandExecutionError("ImageX 未返回完整的封面上传地址和凭证");
  }
  return {
    url: `https://${host}/${store.StoreUri}`,
    authorization: store.Auth,
    sessionKey: address.SessionKey,
  };
}

export async function commitImageUpload(credentials, sessionKey) {
  const result = await imagexRequest(
    "CommitImageUpload",
    credentials,
    {},
    JSON.stringify({ SessionKey: sessionKey }),
  );
  const item = result.Results?.[0];
  if (!item?.Uri || ![200, 2000].includes(item.UriStatus)) {
    throw new CommandExecutionError("ImageX 未确认封面上传成功");
  }
  const metadata = result.PluginResult?.[0];
  return {
    uri: item.Uri,
    width: Number(metadata?.ImageWidth) || 0,
    height: Number(metadata?.ImageHeight) || 0,
  };
}

/**
 * Detect MIME type from file extension.
 * Falls back to image/jpeg for unknown extensions.
 */
function detectContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}
export async function imagexUpload(imagePath, uploadInfo) {
  if (!fs.existsSync(imagePath)) {
    throw new CommandExecutionError(
      `Cover image file not found: ${imagePath}`,
      "Ensure the file path is correct and accessible.",
    );
  }
  const imageBuffer = fs.readFileSync(imagePath);
  const res = await uploadFetch(uploadInfo.url, {
    method: "PUT",
    headers: {
      "Content-Type": detectContentType(imagePath),
      Authorization: uploadInfo.authorization,
      "Content-CRC32": crc32Hex(imageBuffer),
    },
    body: imageBuffer,
    signal: AbortSignal.timeout(60000),
  });
  const payload = await res.json().catch(() => null);
  const code = payload?.error?.error_code ?? payload?.code;
  // The upload gateway can report a storage error in an HTTP 200 response.
  if (!res.ok || (code != null && code !== 0 && code !== 200)) {
    throw new CommandExecutionError(`ImageX 封面上传失败 (HTTP ${res.status})`);
  }
}
