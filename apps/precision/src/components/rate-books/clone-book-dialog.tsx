import { useMutation } from "convex/react";
import { api } from "@truss/backend/convex/_generated/api";
import type { Id } from "@truss/backend/convex/_generated/dataModel";
import { Button } from "@truss/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@truss/ui/components/dialog";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Taking a copy of a book so it can be edited.
 *
 * Shared by the rate-books list and the catalog screen rather than written
 * twice: both places tell an admin that a published book is frozen and that
 * duplicating it is the way forward, and the two must not drift into offering
 * subtly different versions of the same operation.
 *
 * @module
 */

/** The book being copied. `null` closes the dialog. */
export interface CloneSource {
  id: Id<"rateBooks">;
  name: string;
}

export function CloneBookDialog({
  source,
  onOpenChange,
  onCreated,
}: {
  source: CloneSource | null;
  onOpenChange: (open: boolean) => void;
  /** The new draft, so a caller can switch straight to it. */
  onCreated?: (bookId: Id<"rateBooks">) => void;
}) {
  const createDraft = useMutation(api.rateBooks.createDraft);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!source) return;
    // A year is how often this happens, so the year is the obvious name.
    setName(`${new Date().getFullYear()} Rate Book`);
    setBusy(false);
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, [source]);

  if (!source) return null;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createDraft({ parentBookId: source.id, name: name.trim() });
      toast.success("Draft created — copying the catalog now");
      onOpenChange(false);
      onCreated?.(created);
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "Could not create the draft");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>New draft rate book</DialogTitle>
          <DialogDescription>
            Copies every constant from {source.name} into a draft you can edit. Nothing changes for
            estimates already priced from {source.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="book-name">Name</Label>
          <Input
            id="book-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
