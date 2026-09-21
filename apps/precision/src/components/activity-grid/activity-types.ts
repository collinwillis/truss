import {
  Building2,
  DollarSign,
  Package,
  Truck,
  UserPen,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ActivityType } from "@truss/features/activities";

/**
 * How each kind of line is named and drawn.
 *
 * ONE TABLE, because two screens draw these: the activity grid puts the glyph
 * ahead of each line's description, and the totals panel puts the same glyph
 * ahead of the cost it rolls up to. A glyph that means "material" in the grid
 * has to mean "material" in the panel, or it is decoration.
 *
 * ⚠️ NO COLOUR HERE, DELIBERATELY. This table used to carry six saturated hues,
 * and an icon per row in six colours is what got the first attempt retired as
 * "six competing glyphs down a column". The shapes were never the problem. In
 * one quiet grey they read as a silhouette: the eye registers the kind without
 * being asked to look. Colour in this app is reserved for state.
 */
export interface ActivityTypeMeta {
  label: string;
  icon: LucideIcon;
  /** The three-letter code the hidden Type column prints. */
  abbr: string;
}

export const ACTIVITY_TYPE_META: Record<ActivityType, ActivityTypeMeta> = {
  labor: { label: "Labor", icon: Wrench, abbr: "LBR" },
  custom_labor: { label: "Custom Labor", icon: UserPen, abbr: "CLB" },
  material: { label: "Material", icon: Package, abbr: "MAT" },
  equipment: { label: "Equipment", icon: Truck, abbr: "EQP" },
  subcontractor: { label: "Subcontractor", icon: Building2, abbr: "SUB" },
  cost_only: { label: "Cost Only", icon: DollarSign, abbr: "CST" },
};
