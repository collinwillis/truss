"use client";

/**
 * Profile information section with inline editing
 */

import { useState } from "react";
import { useSession } from "@truss/auth/client";
import { ProfileAvatarUpload } from "./profile-avatar-upload";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@truss/ui/components/card";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { Separator } from "@truss/ui/components/separator";
import { Loader2 } from "lucide-react";
import { toast } from "@truss/ui/components/sonner";

/**
 * Profile section for editing user information
 */
export function ProfileSection() {
  const { data: session } = useSession();
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: session?.user?.name || "",
    email: session?.user?.email || "",
  });

  if (!session?.user) {
    return null;
  }

  const user = session.user;
  const hasChanges = formData.name !== (user.name || "") || formData.email !== (user.email || "");

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Simulate API call - replace with actual Better Auth update call
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // TODO: Implement actual user update with Better Auth
      // await authClient.updateUser({ name: formData.name, email: formData.email });

      toast.success("Profile updated successfully");
      setIsEditing(false);
    } catch (error) {
      toast.error("Failed to update profile");
      console.error("Profile update error:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setFormData({
      name: user.name || "",
      email: user.email || "",
    });
    setIsEditing(false);
  };

  const handleAvatarUpload = async (file: File) => {
    // TODO: Implement avatar upload using the file parameter
    // For now, just simulate upload
    console.log("Avatar upload simulated for:", file.name);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    toast.success("Avatar uploaded successfully");
  };

  const joinDate = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "Unknown";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Profile Information</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Update your personal information and profile picture
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Public Profile</CardTitle>
          <CardDescription>
            This information is visible to other members of your organization
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar Upload */}
          <div className="flex justify-center py-4">
            <ProfileAvatarUpload
              currentImage={user.image}
              userName={user.name || undefined}
              userEmail={user.email}
              onUpload={handleAvatarUpload}
              size="lg"
            />
          </div>

          <Separator />

          {/* Form Fields */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => {
                  setFormData({ ...formData, name: e.target.value });
                  setIsEditing(true);
                }}
                placeholder="Enter your full name"
                className="max-w-md"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => {
                  setFormData({ ...formData, email: e.target.value });
                  setIsEditing(true);
                }}
                placeholder="your.email@example.com"
                className="max-w-md"
              />
              <p className="text-xs text-muted-foreground">
                This is your primary email for notifications and account recovery
              </p>
            </div>

            <div className="space-y-2">
              <Label>Member Since</Label>
              <div className="text-sm text-muted-foreground">{joinDate}</div>
            </div>
          </div>

          {/* Action Buttons */}
          {hasChanges && isEditing && (
            <div className="flex gap-3 pt-4">
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
