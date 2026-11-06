export interface PersonalVoice {
  id: string;
  name: string;
  language: "zh-CN" | "en-US";
  status: "submitting" | "processing" | "ready" | "failed" | "unknown";
  error?: string;
  createdAt: string;
}
export interface VoiceLibrary {
  voices: PersonalVoice[];
  cloneEnabled: boolean;
  cloudVoice: string;
  cloudEnabled: boolean;
}
export interface VoiceUpload {
  name: string;
  language: PersonalVoice["language"];
  authorized: boolean;
  audio: string;
  format: "wav" | "mp3" | "m4a";
  requestKey: string;
}
