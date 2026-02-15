/**
 * Mock progress tracking data for Momentum dashboard development.
 *
 * Uses REAL construction terminology from actual industrial projects.
 * Data structure follows PRODUCT_SPEC.md: Project → WBS → Phase → Detail.
 */

export type ProgressStatus = "not-started" | "in-progress" | "complete";
export type ProjectStatus = "active" | "on-hold" | "completed" | "archived";

export interface Project {
  id: string;
  proposalNumber: string;
  jobNumber: string;
  name: string;
  description: string;
  owner: string;
  location: string;
  startDate: string;
  status: ProjectStatus;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  lastUpdated: string;
}

export interface WBSItem {
  id: string;
  projectId: string;
  code: string;
  description: string;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

export interface PhaseItem {
  id: string;
  wbsId: string;
  code: string;
  description: string;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
  status: ProgressStatus;
}

export interface DetailItem {
  id: string;
  wbsId: string;
  phaseId: string;
  description: string;
  quantity: number;
  unit: string;
  quantityComplete: number;
  quantityRemaining: number;
  totalMH: number;
  earnedMH: number;
  percentComplete: number;
}

export interface ProgressEntry {
  id: string;
  detailItemId: string;
  entryDate: string;
  quantityCompleted: number;
  enteredBy: string;
  createdAt: string;
}

// ==================== PROJECTS ====================

export const mockProjects: Project[] = [
  {
    id: "proj1",
    proposalNumber: "1945.02",
    jobNumber: "Nitron 2500T",
    name: "Nitron 2500T (Rev #2)",
    description: "Nitrogen purification system installation",
    owner: "Linde",
    location: "Sherman, Texas",
    startDate: "2025-06-23",
    status: "active",
    totalMH: 6053,
    earnedMH: 2663,
    percentComplete: 44,
    lastUpdated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "proj2",
    proposalNumber: "1876.03",
    jobNumber: "Baytown Refinery",
    name: "Baytown Refinery Expansion",
    description: "Refinery unit expansion and modernization",
    owner: "ExxonMobil",
    location: "Baytown, Texas",
    startDate: "2025-06-22",
    status: "active",
    totalMH: 5280,
    earnedMH: 4488,
    percentComplete: 85,
    lastUpdated: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "proj3",
    proposalNumber: "2001.01",
    jobNumber: "Port Arthur LNG",
    name: "Port Arthur LNG Terminal",
    description: "LNG terminal construction",
    owner: "Sempra Energy",
    location: "Port Arthur, Texas",
    startDate: "2025-06-20",
    status: "active",
    totalMH: 8920,
    earnedMH: 892,
    percentComplete: 10,
    lastUpdated: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "proj4",
    proposalNumber: "1823.05",
    jobNumber: "Corpus Christi FPSO",
    name: "Corpus Christi FPSO Topsides",
    description: "FPSO topside module fabrication",
    owner: "Shell",
    location: "Corpus Christi, Texas",
    startDate: "2025-06-15",
    status: "completed",
    totalMH: 12400,
    earnedMH: 12400,
    percentComplete: 100,
    lastUpdated: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  },
];

// ==================== WBS ITEMS (REAL CODES & NAMES) ====================

export const mockWBSItems: WBSItem[] = [
  {
    id: "1",
    projectId: "proj1",
    code: "10000",
    description: "MOBILIZE",
    totalMH: 88,
    earnedMH: 88.0,
    percentComplete: 100,
    status: "complete",
  },
  {
    id: "2",
    projectId: "proj1",
    code: "30000",
    description: "CONCRETE",
    totalMH: 450,
    earnedMH: 337.5,
    percentComplete: 75,
    status: "in-progress",
  },
  {
    id: "3",
    projectId: "proj1",
    code: "60000",
    description: "STRUCTURAL",
    totalMH: 1200,
    earnedMH: 720.0,
    percentComplete: 60,
    status: "in-progress",
  },
  {
    id: "4",
    projectId: "proj1",
    code: "70000",
    description: "AG PIPING",
    totalMH: 2800,
    earnedMH: 1260.0,
    percentComplete: 45,
    status: "in-progress",
  },
  {
    id: "5",
    projectId: "proj1",
    code: "80000",
    description: "ELECTRICAL",
    totalMH: 650,
    earnedMH: 195.0,
    percentComplete: 30,
    status: "in-progress",
  },
  {
    id: "6",
    projectId: "proj1",
    code: "90000",
    description: "INSTRUMENTS",
    totalMH: 420,
    earnedMH: 63.0,
    percentComplete: 15,
    status: "in-progress",
  },
  {
    id: "7",
    projectId: "proj1",
    code: "100000",
    description: "INSULATION",
    totalMH: 380,
    earnedMH: 19.0,
    percentComplete: 5,
    status: "in-progress",
  },
  {
    id: "8",
    projectId: "proj1",
    code: "190000",
    description: "DEMOBILIZE",
    totalMH: 65,
    earnedMH: 0.0,
    percentComplete: 0,
    status: "not-started",
  },
];

// ==================== PHASE ITEMS (REAL CODES & DESCRIPTIONS) ====================

export const mockPhaseItems: PhaseItem[] = [
  {
    id: "p1",
    wbsId: "1",
    code: "10001",
    description: "EQUIPMENT SETUP",
    totalMH: 44.0,
    earnedMH: 44.0,
    percentComplete: 100,
    status: "complete",
  },
  {
    id: "p2",
    wbsId: "1",
    code: "10002",
    description: "TRAILER SETUP",
    totalMH: 44.0,
    earnedMH: 44.0,
    percentComplete: 100,
    status: "complete",
  },
  {
    id: "p3",
    wbsId: "2",
    code: "30001",
    description: "EQUIPMENT FOUNDATIONS (≤3 CY)",
    totalMH: 225.0,
    earnedMH: 157.5,
    percentComplete: 70,
    status: "in-progress",
  },
  {
    id: "p4",
    wbsId: "2",
    code: "30002",
    description: "EQUIPMENT FOUNDATIONS (4-10 CY)",
    totalMH: 225.0,
    earnedMH: 180.0,
    percentComplete: 80,
    status: "in-progress",
  },
  {
    id: "p5",
    wbsId: "3",
    code: "60001",
    description: "STRUCTURAL STEEL FABRICATION",
    totalMH: 600.0,
    earnedMH: 330.0,
    percentComplete: 55,
    status: "in-progress",
  },
  {
    id: "p6",
    wbsId: "3",
    code: "60002",
    description: "PLATFORM FABRICATION",
    totalMH: 600.0,
    earnedMH: 390.0,
    percentComplete: 65,
    status: "in-progress",
  },
  {
    id: "p7",
    wbsId: "4",
    code: "70001",
    description: "CARBON STEEL - A106/A53 (SCH 10/40)",
    totalMH: 1400.0,
    earnedMH: 700.0,
    percentComplete: 50,
    status: "in-progress",
  },
  {
    id: "p8",
    wbsId: "4",
    code: "70002",
    description: "CARBON STEEL - A106/A53 (SCH 80/XS)",
    totalMH: 1400.0,
    earnedMH: 560.0,
    percentComplete: 40,
    status: "in-progress",
  },
  {
    id: "p9",
    wbsId: "5",
    code: "80001",
    description: "ELECTRICAL",
    totalMH: 325.0,
    earnedMH: 97.5,
    percentComplete: 30,
    status: "in-progress",
  },
  {
    id: "p10",
    wbsId: "5",
    code: "89999",
    description: "MATERIAL",
    totalMH: 325.0,
    earnedMH: 97.5,
    percentComplete: 30,
    status: "in-progress",
  },
  {
    id: "p11",
    wbsId: "6",
    code: "90001",
    description: "CV - CONTROL VALVE",
    totalMH: 210.0,
    earnedMH: 21.0,
    percentComplete: 10,
    status: "in-progress",
  },
  {
    id: "p12",
    wbsId: "6",
    code: "90002",
    description: "TI - TEMPERATURE INDICATOR",
    totalMH: 210.0,
    earnedMH: 42.0,
    percentComplete: 20,
    status: "in-progress",
  },
  {
    id: "p13",
    wbsId: "7",
    code: "100001",
    description: "INSULATION",
    totalMH: 190.0,
    earnedMH: 9.5,
    percentComplete: 5,
    status: "in-progress",
  },
  {
    id: "p14",
    wbsId: "7",
    code: "109999",
    description: "MATERIAL",
    totalMH: 190.0,
    earnedMH: 9.5,
    percentComplete: 5,
    status: "in-progress",
  },
  {
    id: "p15",
    wbsId: "8",
    code: "190001",
    description: "SITE CLEAN UP",
    totalMH: 32.5,
    earnedMH: 0.0,
    percentComplete: 0,
    status: "not-started",
  },
  {
    id: "p16",
    wbsId: "8",
    code: "190002",
    description: "EQUIPMENT REMOVAL",
    totalMH: 32.5,
    earnedMH: 0.0,
    percentComplete: 0,
    status: "not-started",
  },
];

// ==================== DETAIL ITEMS (REAL ACTIVITY NAMES) ====================

export const mockDetailItems: DetailItem[] = [
  // 10000 MOBILIZE → 10001 EQUIPMENT SETUP
  {
    id: "d1",
    wbsId: "1",
    phaseId: "p1",
    description: "TOOLS",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d2",
    wbsId: "1",
    phaseId: "p1",
    description: "EQUIPMENT",
    quantity: 4,
    unit: "EA",
    quantityComplete: 4,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d3",
    wbsId: "1",
    phaseId: "p1",
    description: "CRANES",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d4",
    wbsId: "1",
    phaseId: "p1",
    description: "WELDING HUTCHES",
    quantity: 2,
    unit: "EA",
    quantityComplete: 2,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  // 10000 MOBILIZE → 10002 TRAILER SETUP
  {
    id: "d5",
    wbsId: "1",
    phaseId: "p2",
    description: "OFFICE TRAILER",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d6",
    wbsId: "1",
    phaseId: "p2",
    description: "CHANGE TRAILER",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d7",
    wbsId: "1",
    phaseId: "p2",
    description: "TOOL TRAILER",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  {
    id: "d8",
    wbsId: "1",
    phaseId: "p2",
    description: "MATERIAL TRAILER",
    quantity: 1,
    unit: "EA",
    quantityComplete: 1,
    quantityRemaining: 0,
    totalMH: 11.0,
    earnedMH: 11.0,
    percentComplete: 100,
  },
  // 30000 CONCRETE → 30001 EQUIPMENT FOUNDATIONS (≤3 CY)
  {
    id: "d9",
    wbsId: "2",
    phaseId: "p3",
    description: "LAYOUT",
    quantity: 8,
    unit: "EA",
    quantityComplete: 6,
    quantityRemaining: 2,
    totalMH: 56.0,
    earnedMH: 42.0,
    percentComplete: 75,
  },
  {
    id: "d10",
    wbsId: "2",
    phaseId: "p3",
    description: "EXCAVATE TO ELEVATION",
    quantity: 30,
    unit: "CY",
    quantityComplete: 20,
    quantityRemaining: 10,
    totalMH: 56.0,
    earnedMH: 37.3,
    percentComplete: 67,
  },
  {
    id: "d11",
    wbsId: "2",
    phaseId: "p3",
    description: "BACKFILL TO ELEVATION",
    quantity: 30,
    unit: "CY",
    quantityComplete: 22,
    quantityRemaining: 8,
    totalMH: 56.0,
    earnedMH: 41.1,
    percentComplete: 73,
  },
  {
    id: "d12",
    wbsId: "2",
    phaseId: "p3",
    description: "FORMWORK - FOOTER",
    quantity: 200,
    unit: "SF",
    quantityComplete: 140,
    quantityRemaining: 60,
    totalMH: 57.0,
    earnedMH: 39.9,
    percentComplete: 70,
  },
  // 30000 CONCRETE → 30002 EQUIPMENT FOUNDATIONS (4-10 CY)
  {
    id: "d13",
    wbsId: "2",
    phaseId: "p4",
    description: "LAYOUT",
    quantity: 4,
    unit: "EA",
    quantityComplete: 3,
    quantityRemaining: 1,
    totalMH: 56.0,
    earnedMH: 42.0,
    percentComplete: 75,
  },
  {
    id: "d14",
    wbsId: "2",
    phaseId: "p4",
    description: "EXCAVATE TO ELEVATION",
    quantity: 50,
    unit: "CY",
    quantityComplete: 40,
    quantityRemaining: 10,
    totalMH: 56.0,
    earnedMH: 44.8,
    percentComplete: 80,
  },
  {
    id: "d15",
    wbsId: "2",
    phaseId: "p4",
    description: "BACKFILL TO ELEVATION",
    quantity: 50,
    unit: "CY",
    quantityComplete: 42,
    quantityRemaining: 8,
    totalMH: 56.0,
    earnedMH: 47.0,
    percentComplete: 84,
  },
  {
    id: "d16",
    wbsId: "2",
    phaseId: "p4",
    description: "FORMWORK - FOOTER",
    quantity: 500,
    unit: "SF",
    quantityComplete: 375,
    quantityRemaining: 125,
    totalMH: 57.0,
    earnedMH: 42.8,
    percentComplete: 75,
  },
  // 60000 STRUCTURAL → 60001 STRUCTURAL STEEL FABRICATION
  {
    id: "d17",
    wbsId: "3",
    phaseId: "p5",
    description: "OFFLOAD MATERIALS",
    quantity: 20,
    unit: "TON",
    quantityComplete: 10,
    quantityRemaining: 10,
    totalMH: 150.0,
    earnedMH: 75.0,
    percentComplete: 50,
  },
  {
    id: "d18",
    wbsId: "3",
    phaseId: "p5",
    description: "FABRICATE - PARTITION FRAMING",
    quantity: 15,
    unit: "TON",
    quantityComplete: 8,
    quantityRemaining: 7,
    totalMH: 150.0,
    earnedMH: 80.0,
    percentComplete: 53,
  },
  {
    id: "d19",
    wbsId: "3",
    phaseId: "p5",
    description: "FABRICATE - EQUIPMENT SUPPORTS",
    quantity: 15,
    unit: "TON",
    quantityComplete: 9,
    quantityRemaining: 6,
    totalMH: 150.0,
    earnedMH: 90.0,
    percentComplete: 60,
  },
  {
    id: "d20",
    wbsId: "3",
    phaseId: "p5",
    description: "FLAME CUTTING - 3/16 THK. - 5/16 THK.",
    quantity: 500,
    unit: "LF",
    quantityComplete: 275,
    quantityRemaining: 225,
    totalMH: 150.0,
    earnedMH: 82.5,
    percentComplete: 55,
  },
  // 60000 STRUCTURAL → 60002 PLATFORM FABRICATION
  {
    id: "d21",
    wbsId: "3",
    phaseId: "p6",
    description: "OFFLOAD MATERIALS",
    quantity: 20,
    unit: "TON",
    quantityComplete: 14,
    quantityRemaining: 6,
    totalMH: 150.0,
    earnedMH: 105.0,
    percentComplete: 70,
  },
  {
    id: "d22",
    wbsId: "3",
    phaseId: "p6",
    description: "FABRICATE - PARTITION FRAMING",
    quantity: 15,
    unit: "TON",
    quantityComplete: 9,
    quantityRemaining: 6,
    totalMH: 150.0,
    earnedMH: 90.0,
    percentComplete: 60,
  },
  {
    id: "d23",
    wbsId: "3",
    phaseId: "p6",
    description: "FABRICATE - EQUIPMENT SUPPORTS",
    quantity: 15,
    unit: "TON",
    quantityComplete: 10,
    quantityRemaining: 5,
    totalMH: 150.0,
    earnedMH: 100.0,
    percentComplete: 67,
  },
  {
    id: "d24",
    wbsId: "3",
    phaseId: "p6",
    description: "FLAME CUTTING - 3/16 THK. - 5/16 THK.",
    quantity: 500,
    unit: "LF",
    quantityComplete: 325,
    quantityRemaining: 175,
    totalMH: 150.0,
    earnedMH: 97.5,
    percentComplete: 65,
  },
  // 70000 AG PIPING → 70001 CARBON STEEL (SCH 10/40)
  {
    id: "d25",
    wbsId: "4",
    phaseId: "p7",
    description: 'HE - 60 (60" PIPE)',
    quantity: 1000,
    unit: "LF",
    quantityComplete: 500,
    quantityRemaining: 500,
    totalMH: 350.0,
    earnedMH: 175.0,
    percentComplete: 50,
  },
  {
    id: "d26",
    wbsId: "4",
    phaseId: "p7",
    description: 'HE - 54 (54" PIPE)',
    quantity: 500,
    unit: "LF",
    quantityComplete: 250,
    quantityRemaining: 250,
    totalMH: 350.0,
    earnedMH: 175.0,
    percentComplete: 50,
  },
  {
    id: "d27",
    wbsId: "4",
    phaseId: "p7",
    description: 'HE - 48 (48" PIPE)',
    quantity: 500,
    unit: "LF",
    quantityComplete: 250,
    quantityRemaining: 250,
    totalMH: 350.0,
    earnedMH: 175.0,
    percentComplete: 50,
  },
  {
    id: "d28",
    wbsId: "4",
    phaseId: "p7",
    description: 'HE - 46 (46" PIPE)',
    quantity: 200,
    unit: "LF",
    quantityComplete: 100,
    quantityRemaining: 100,
    totalMH: 350.0,
    earnedMH: 175.0,
    percentComplete: 50,
  },
  // 70000 AG PIPING → 70002 CARBON STEEL (SCH 80/XS)
  {
    id: "d29",
    wbsId: "4",
    phaseId: "p8",
    description: 'HE - 60 (60" PIPE)',
    quantity: 200,
    unit: "LF",
    quantityComplete: 80,
    quantityRemaining: 120,
    totalMH: 350.0,
    earnedMH: 140.0,
    percentComplete: 40,
  },
  {
    id: "d30",
    wbsId: "4",
    phaseId: "p8",
    description: 'HE - 54 (54" PIPE)',
    quantity: 200,
    unit: "LF",
    quantityComplete: 80,
    quantityRemaining: 120,
    totalMH: 350.0,
    earnedMH: 140.0,
    percentComplete: 40,
  },
  {
    id: "d31",
    wbsId: "4",
    phaseId: "p8",
    description: 'HE - 48 (48" PIPE)',
    quantity: 200,
    unit: "LF",
    quantityComplete: 80,
    quantityRemaining: 120,
    totalMH: 350.0,
    earnedMH: 140.0,
    percentComplete: 40,
  },
  {
    id: "d32",
    wbsId: "4",
    phaseId: "p8",
    description: 'HE - 46 (46" PIPE)',
    quantity: 100,
    unit: "LF",
    quantityComplete: 40,
    quantityRemaining: 60,
    totalMH: 350.0,
    earnedMH: 140.0,
    percentComplete: 40,
  },
];

// ==================== HELPER FUNCTIONS ====================

export function getProjectById(id: string): Project | undefined {
  return mockProjects.find((p) => p.id === id);
}

export function getWBSByProject(projectId: string): WBSItem[] {
  return mockWBSItems.filter((w) => w.projectId === projectId);
}

export function getWBSById(id: string): WBSItem | undefined {
  return mockWBSItems.find((w) => w.id === id);
}

export function getPhasesByWBS(wbsId: string): PhaseItem[] {
  return mockPhaseItems.filter((p) => p.wbsId === wbsId);
}

export function getPhaseById(id: string): PhaseItem | undefined {
  return mockPhaseItems.find((p) => p.id === id);
}

export function getDetailsByPhase(phaseId: string): DetailItem[] {
  return mockDetailItems.filter((d) => d.phaseId === phaseId);
}

export function getActiveProjects(): Project[] {
  return mockProjects.filter((p) => p.status === "active");
}

export function getRecentProjects(): Project[] {
  return mockProjects
    .slice()
    .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
    .slice(0, 5);
}

function getStatusFromPercent(percent: number): ProgressStatus {
  if (percent === 0) return "not-started";
  if (percent === 100) return "complete";
  return "in-progress";
}

// ==================== ENTRY FORM HELPERS ====================

export interface ProgressMetrics {
  previousTotal: number;
  todaysEntry: number;
  newTotal: number;
  remaining: number;
  percentComplete: number;
}

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Calculate progress metrics for a detail item on a specific date.
 */
export function calculateProgress(item: DetailItem, date: string): ProgressMetrics {
  // Mock: In real implementation, would fetch entries for this date
  return {
    previousTotal: item.quantityComplete,
    todaysEntry: 0,
    newTotal: item.quantityComplete,
    remaining: item.quantityRemaining,
    percentComplete: item.percentComplete,
  };
}

/**
 * Get suggested quantity based on historical patterns.
 */
export function getSuggestedQuantity(item: DetailItem, date: string): number | null {
  // Mock: Return null (no suggestion)
  // Real implementation would analyze historical data
  if (item.quantityRemaining > 0 && item.percentComplete > 0) {
    // Suggest completing 25% of remaining
    return Math.ceil(item.quantityRemaining * 0.25);
  }
  return null;
}

/**
 * Validate quantity entry against business rules.
 */
export function validateQuantityEntry(
  quantity: number,
  item: DetailItem,
  date: string
): ValidationResult {
  // Negative check
  if (quantity < 0) {
    return {
      isValid: false,
      error: "Quantity cannot be negative",
    };
  }

  // Zero check
  if (quantity === 0) {
    return {
      isValid: false,
      error: "Quantity must be greater than zero",
    };
  }

  // Exceeds remaining
  if (quantity > item.quantityRemaining) {
    return {
      isValid: false,
      warning: `You've entered ${quantity} ${item.unit}, but only ${item.quantityRemaining} ${item.unit} remain. Adjust quantity or update estimate?`,
    };
  }

  // Unusually high (more than 3x typical)
  const typical = item.quantity / 10; // Mock: assume 10% per day is typical
  if (quantity > typical * 3) {
    return {
      isValid: true,
      warning: `This is ${Math.round(quantity / typical)}x your typical daily output. Double-check this entry.`,
    };
  }

  return { isValid: true };
}
