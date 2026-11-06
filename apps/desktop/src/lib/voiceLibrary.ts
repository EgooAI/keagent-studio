import { useQuery } from "@tanstack/react-query";
import { authRequest, isLive } from "@keagent/api-client";
import type { VoiceLibrary, VoiceUpload } from "@keagent/shared-types";

export function useVoiceLibrary() {
  return useQuery({
    queryKey: ["personal-voices"],
    queryFn: () => authRequest<VoiceLibrary>("voice.list"),
    enabled: isLive,
    retry: false,
    refetchInterval: 10000,
  });
}
export function voiceFormat(
  file: Pick<File, "name" | "size">,
): VoiceUpload["format"] {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (
    !["wav", "mp3", "m4a"].includes(extension || "") ||
    file.size === 0 ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("请选择不超过10 MB的 WAV、MP3 或 M4A 录音");
  return extension as VoiceUpload["format"];
}
export function validateRecordingDuration(duration: number) {
  if (!Number.isFinite(duration) || duration < 5 || duration > 30)
    throw new Error("录音需要5–30秒，建议使用10–15秒的清晰单人讲话");
}
export async function validateRecording(file: File) {
  voiceFormat(file);
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("无法读取录音，请转换为 WAV 或 MP3 后重试")),
        10000,
      );
      audio.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      audio.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法解码录音，请检查音频文件"));
      };
      audio.src = url;
    });
    validateRecordingDuration(audio.duration);
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}
export async function encodeRecording(file: File): Promise<string> {
  voiceFormat(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取录音失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
export function audioBlobURL(audio: string, mime: string) {
  if (
    audio.length > 8 * 1024 * 1024 ||
    ![
      "audio/wave",
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/ogg",
      "application/ogg",
    ].includes(mime)
  )
    throw new Error("试听音频格式无效");
  const bytes = Uint8Array.from(atob(audio), (character) =>
    character.charCodeAt(0),
  );
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
