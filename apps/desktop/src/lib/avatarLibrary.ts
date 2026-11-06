import { useQuery } from "@tanstack/react-query";
import { authRequest, isLive } from "@keagent/api-client";
import type { AvatarLibrary } from "@keagent/shared-types";
export function useAvatarLibrary() {
  return useQuery({
    queryKey: ["personal-avatars"],
    queryFn: () => authRequest<AvatarLibrary>("avatar.list"),
    enabled: isLive,
    retry: false,
    refetchInterval: 10000,
  });
}
export function validatePhotoFile(file: Pick<File, "size" | "type">) {
  if (
    !["image/jpeg", "image/png"].includes(file.type) ||
    file.size === 0 ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("请选择不超过5 MB的 JPEG / PNG 本人照片");
}
export async function encodePhoto(file: File): Promise<string> {
  validatePhotoFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取照片失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
export function photoBlobURL(photo: string, mime: string) {
  if (
    !["image/jpeg", "image/png"].includes(mime) ||
    photo.length > 8 * 1024 * 1024
  )
    throw new Error("照片格式无效");
  return URL.createObjectURL(
    new Blob(
      [Uint8Array.from(atob(photo), (character) => character.charCodeAt(0))],
      { type: mime },
    ),
  );
}
