"use client";

/**
 * Profile avatar upload component with drag-and-drop support
 */

import { useState, useRef } from "react";
import { Upload, Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@truss/ui/components/avatar";
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";

interface ProfileAvatarUploadProps {
  currentImage?: string | null;
  userName?: string;
  userEmail: string;
  onUpload?: (file: File) => Promise<void>;
  size?: "default" | "lg";
}

/**
 * Avatar upload component with hover overlay and file picker
 */
export function ProfileAvatarUpload({
  currentImage,
  userName,
  userEmail,
  onUpload,
  size = "lg",
}: ProfileAvatarUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = userName
    ? userName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : userEmail.slice(0, 2).toUpperCase();

  const avatarSize = size === "lg" ? "h-32 w-32" : "h-24 w-24";
  const textSize = size === "lg" ? "text-4xl" : "text-2xl";

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (onUpload) {
      setIsUploading(true);
      try {
        await onUpload(file);
      } catch (error) {
        console.error("Failed to upload avatar:", error);
        setPreviewUrl(null);
      } finally {
        setIsUploading(false);
      }
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative group">
        <Avatar className={cn(avatarSize, "rounded-2xl transition-all duration-200")}>
          <AvatarImage
            src={previewUrl || currentImage || undefined}
            alt={userName || userEmail}
            className="object-cover"
          />
          <AvatarFallback className={cn("rounded-2xl", textSize)}>{initials}</AvatarFallback>
        </Avatar>

        {/* Hover Overlay */}
        <button
          onClick={handleClick}
          disabled={isUploading}
          className={cn(
            "absolute inset-0 rounded-2xl bg-background/80 backdrop-blur-sm",
            "flex flex-col items-center justify-center gap-2",
            "opacity-0 group-hover:opacity-100",
            "transition-all duration-200 ease-out",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-primary focus-visible:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {isUploading ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-xs font-medium text-foreground">Uploading...</span>
            </>
          ) : (
            <>
              <Upload className="h-8 w-8 text-primary" />
              <span className="text-xs font-medium text-foreground">Change photo</span>
            </>
          )}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileInputChange}
          className="hidden"
          disabled={isUploading}
        />
      </div>

      <div className="text-center">
        <Button variant="outline" size="sm" onClick={handleClick} disabled={isUploading}>
          <Upload className="h-4 w-4 mr-2" />
          Upload Photo
        </Button>
        <p className="text-xs text-muted-foreground mt-2">JPG, PNG or WebP. Max 5MB.</p>
      </div>
    </div>
  );
}
