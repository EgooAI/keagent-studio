export interface PersonalAvatar {
  id: string;
  name: string;
  status: "submitting" | "ready" | "unknown";
  error?: string;
  createdAt: string;
}
export interface AvatarLibrary {
  avatars: PersonalAvatar[];
  uploadEnabled: boolean;
}
