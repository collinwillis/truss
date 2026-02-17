# Momentum - Progress Tracking System

**Product Specification & Technical Reference**

---

## Table of Contents

1. [Overview](#overview)
2. [Current State: Excel Analysis](#current-state-excel-analysis)
3. [Data Structure & Hierarchy](#data-structure--hierarchy)
4. [Calculation Logic](#calculation-logic)
5. [User Workflows](#user-workflows)
6. [Feature Requirements](#feature-requirements)
7. [Data Model](#data-model)
8. [Technical Architecture](#technical-architecture)
9. [UI/UX Design Principles](#uiux-design-principles)
10. [Implementation Phases](#implementation-phases)
11. [Appendix](#appendix)

---

## Overview

### What is Momentum?

**Momentum** is a desktop-based progress tracking application for construction and industrial
projects. It transforms the traditional Excel-based progress tracking workflow into a modern,
real-time, collaborative system.

**Core Purpose:**

- Track daily work completion (quantities completed)
- Calculate earned man-hours based on completed work
- Provide real-time visibility into project progress
- Enable field workers to enter data quickly and accurately
- Generate reports and dashboards for project managers

**Target Users:**

- **Field Supervisors/Foremen** - Enter daily quantities completed
- **Project Managers** - Monitor progress, identify issues, generate reports
- **Executives/Stakeholders** - View high-level project status

**Technology Stack:**

- **Platform:** Tauri v2 Desktop Application
- **Frontend:** React 19 + Vite + Tailwind CSS v4
- **Database:** Supabase (Postgres + Real-time subscriptions)
- **Auth:** Better Auth
- **Package Manager:** Bun

---

## Current State: Excel Analysis

### The Excel Workflow

**File:** `1247 - Progress Tracking MASTER.xlsx`

**Project Example:**

- Proposal: 1945.02
- Job: Nitron 2500T
- Owner: Linde
- Location: Sherman, Texas
- Start Date: June 23, 2025

**Scale:**

- 416 total rows
- 8 WBS (Work Breakdown Structure) items
- 77 Phase items
- 321 Detail items
- 80+ columns of data

### Excel Structure (6 Sections)

#### Section 1: Scope Breakdown (Columns A-J)

| Column | Name           | Description                                 |
| ------ | -------------- | ------------------------------------------- |
| A      | Filter         | Hierarchy level indicator (W/P/D)           |
| B      | WBS            | Work Breakdown Structure code (e.g., 10000) |
| C      | PHASE          | Phase code (e.g., 10001)                    |
| D      | SIZE           | Size specification                          |
| E      | FLC            | Field code                                  |
| F      | LINE / DESCRIP | Description of work item                    |
| G      | SPEC           | Specification                               |
| H      | INSUL          | Insulation type                             |
| I      | INSL. SIZE     | Insulation size                             |
| J      | SHT            | Sheet number (reference drawing)            |

**Purpose:** Metadata from estimate phase - imported from MCP estimator

---

#### Section 2: Estimate Basis (Columns K-O)

| Column | Name  | Description             | Example       |
| ------ | ----- | ----------------------- | ------------- |
| K      | QTY   | Quantity from estimate  | 4             |
| L      | UNIT  | Unit of measure         | EA, SF, CRAFT |
| M      | CRAFT | Craft man-hours         | 8             |
| N      | WELD  | Weld man-hours          | 0             |
| O      | TOTAL | Total man-hours (M + N) | 8             |

**Purpose:** Baseline for progress calculations - source of truth from estimate

---

#### Section 3: Progress Calculations (Columns P-T)

| Column | Name                 | Formula      | Description               |
| ------ | -------------------- | ------------ | ------------------------- |
| P      | QTY COMPLETE         | `SUM(BM:BS)` | Total completed quantity  |
| Q      | QTY REMAINING        | `K - P`      | Quantity left to complete |
| R      | MH EARNED            | `SUM(BU:CA)` | Total earned man-hours    |
| S      | MH REMAINING TO EARN | `O - R`      | Man-hours left to earn    |
| T      | % COMPLETE           | `R / O`      | Percent complete (by MH)  |

**Purpose:** Real-time calculated progress metrics - auto-updates as data is entered

---

#### Section 4: Completed Quantities by Day (Columns V-BK)

**42 daily columns** organized into weeks:

| Week   | Columns | Days                | Purpose            |
| ------ | ------- | ------------------- | ------------------ |
| Week 1 | V-AA    | M, Tu, W, Th, F, Sa | Daily entry Week 1 |
| Week 2 | AB-AG   | M, Tu, W, Th, F, Sa | Daily entry Week 2 |
| Week 3 | AH-AM   | M, Tu, W, Th, F, Sa | Daily entry Week 3 |
| Week 4 | AN-AS   | M, Tu, W, Th, F, Sa | Daily entry Week 4 |
| Week 5 | AT-AY   | M, Tu, W, Th, F, Sa | Daily entry Week 5 |
| Week 6 | AZ-BE   | M, Tu, W, Th, F, Sa | Daily entry Week 6 |
| Week 7 | BF-BK   | M, Tu, W, Th, F, Sa | Daily entry Week 7 |

**Purpose:** **ONLY USER INPUT SECTION** - Field workers enter completed quantities here

**Example:**

- Monday (V12): Enter "1" (completed 1 EA)
- Tuesday (W13): Enter "1" (completed 1 EA)
- System auto-calculates progress

---

#### Section 5: Weekly Completed Quantities (Columns BM-BS)

| Column | Formula      | Description      |
| ------ | ------------ | ---------------- |
| BM     | `SUM(V:AA)`  | Week 1 Total Qty |
| BN     | `SUM(AB:AG)` | Week 2 Total Qty |
| BO     | `SUM(AH:AM)` | Week 3 Total Qty |
| BP     | `SUM(AN:AS)` | Week 4 Total Qty |
| BQ     | `SUM(AT:AY)` | Week 5 Total Qty |
| BR     | `SUM(AZ:BE)` | Week 6 Total Qty |
| BS     | `SUM(BF:BK)` | Week 7 Total Qty |

**Purpose:** Aggregate daily entries for weekly reporting and trend analysis

---

#### Section 6: Weekly Earned Man-hours (Columns BU-CA)

| Column | Formula      | Description      |
| ------ | ------------ | ---------------- |
| BU     | `(BM/$K)*$O` | Week 1 Earned MH |
| BV     | `(BN/$K)*$O` | Week 2 Earned MH |
| BW     | `(BO/$K)*$O` | Week 3 Earned MH |
| BX     | `(BP/$K)*$O` | Week 4 Earned MH |
| BY     | `(BQ/$K)*$O` | Week 5 Earned MH |
| BZ     | `(BR/$K)*$O` | Week 6 Earned MH |
| CA     | `(BS/$K)*$O` | Week 7 Earned MH |

**Formula Breakdown:**

```
Earned MH = (Completed Qty This Week / Total Estimated Qty) × Total Estimated MH
```

**Example (Row 12 - TOOLS):**

- Estimate: 1 EA, 5 MH total
- Week 1 Complete: 1 EA (BM12)
- Week 1 Earned MH: (1/1) × 5 = **5 MH** (BU12)

**Purpose:** Convert completed quantities to earned man-hours, preserving weekly time slices for
burn-down analysis

---

### Excel Pain Points

#### 1. Cognitive Overload

- 80+ columns to navigate horizontally
- Users must scroll right to find correct date column
- Easy to enter data in wrong cell
- Column headers use Excel serial dates (45844 instead of "June 23, 2025")

#### 2. No Data Validation

- Can enter more quantity than estimated (over-report progress)
- No warnings for anomalies or mistakes
- Formula cells can be accidentally overwritten
- No audit trail of who entered what

#### 3. Poor Mobile/Field Access

- Excel on tablets/phones is clunky
- Small touch targets, requires pinch/zoom
- Difficult to use on job site with gloves

#### 4. No Real-Time Collaboration

- File must be saved and shared manually
- Version conflicts ("who has the latest file?")
- Can't see what others are entering in real-time
- Email attachments create multiple copies

#### 5. Limited Visualization

- No charts or graphs for trends
- Hard to spot problem areas quickly
- Weekly/daily patterns not visible without manual charting
- No dashboards for at-a-glance status

#### 6. Manual Date Management

- Column headers need manual updates each week
- Must know which column corresponds to which date
- No calendar interface

#### 7. Reporting Friction

- Need to manually copy/paste/format for stakeholders
- Can't filter or drill down easily
- No automated alerts for delays or issues
- Hard to answer questions like "What was completed last Tuesday?"

---

## Data Structure & Hierarchy

### 3-Level Hierarchy

```
W (WBS Level)        → High-level scope breakdown
├─ P (Phase Level)   → Intermediate grouping
   ├─ D (Detail Level)  → Specific work items with quantities
```

### Example Hierarchy

```
W: 10000 MOBILIZE (88 MH total)
├─ P: 10001 EQUIPMENT SETUP (13 MH)
│  ├─ D: TOOLS (1 EA, 5 MH)
│  └─ D: EQUIPMENT (4 EA, 8 MH)
├─ P: 10002 TRAILER SETUP (10 MH)
│  └─ D: TOOL TRAILER (1 EA, 10 MH)
└─ P: 10004 SAFETY ORIENTATION (55 MH)
   ├─ D: CUSTOMER SAFETY ORIENTATION (11 CRAFT, 44 MH)
   └─ D: INDEMAND SAFETY ORIENTATION (11 CRAFT, 11 MH)

W: 30000 CONCRETE (58.88 MH total)
└─ P: 30001 CEMENTITIOUS GROUT (27.85 MH)
   ├─ D: BUSH HAMMER (11 SF, 3.85 MH)
   ├─ D: PREPURIFIER VESSEL A (4 EA, 8 MH)
   └─ D: PREPURIFIER VESSEL B (4 EA, 8 MH)
```

### Hierarchy Rules

1. **W (WBS)** items:
   - Top-level grouping (e.g., "MOBILIZE", "CONCRETE", "PIPING")
   - May or may not have quantities
   - Total MH = sum of all child phases
   - Used for high-level reporting

2. **P (Phase)** items:
   - Mid-level grouping under WBS
   - May or may not have quantities
   - Total MH = sum of all child details
   - Used for tracking discrete work packages

3. **D (Detail)** items:
   - Always have quantities and man-hours
   - This is where daily progress is entered
   - Leaf nodes in the hierarchy
   - Used for day-to-day work tracking

### Data Flow

```
Estimate Phase (MCP) → Momentum Import
                        ↓
                    WBS Hierarchy
                        ↓
            Daily Quantity Entry (Detail level)
                        ↓
                Weekly Aggregation
                        ↓
            Earned MH Calculation
                        ↓
        Progress % (rolls up to Phase → WBS)
```

---

## Calculation Logic

### Progress Calculation Flow

```
Step 1: User Entry
  ↓ User enters daily quantity in Section 4 (e.g., "1 EA on Monday")

Step 2: Weekly Aggregation
  ↓ System sums daily entries to weekly totals (Section 5)
  ↓ Formula: SUM(V:AA) for Week 1, SUM(AB:AG) for Week 2, etc.

Step 3: Weekly Earned MH
  ↓ System calculates man-hours earned each week (Section 6)
  ↓ Formula: (Weekly Qty / Estimate Qty) × Total MH

Step 4: Cumulative Totals
  ↓ System sums weekly values to cumulative (Section 3)
  ↓ QTY COMPLETE = SUM(all weekly qty)
  ↓ MH EARNED = SUM(all weekly MH)

Step 5: Progress Metrics
  ↓ System calculates remaining and % complete (Section 3)
  ↓ QTY REMAINING = Estimate - Complete
  ↓ MH REMAINING = Total MH - Earned MH
  ↓ % COMPLETE = Earned MH / Total MH
```

### Example Calculation

**Item:** EQUIPMENT (Row 13)

- **Estimate Basis:** 4 EA, 8 MH total

**User Entries:**

- Monday (V13): 1 EA
- Tuesday (W13): 1 EA
- Wednesday (X13): 1 EA
- Week 2 Monday (AB13): 1 EA

**Calculations:**

**Week 1 Total (BM13):**

```
SUM(V13:AA13) = 1 + 1 + 1 = 3 EA
```

**Week 1 Earned MH (BU13):**

```
(BM13 / K13) × O13 = (3 / 4) × 8 = 6 MH
```

**Week 2 Total (BN13):**

```
SUM(AB13:AG13) = 1 EA
```

**Week 2 Earned MH (BV13):**

```
(BN13 / K13) × O13 = (1 / 4) × 8 = 2 MH
```

**Cumulative Qty Complete (P13):**

```
SUM(BM13:BS13) = 3 + 1 = 4 EA
```

**Cumulative MH Earned (R13):**

```
SUM(BU13:CA13) = 6 + 2 = 8 MH
```

**Qty Remaining (Q13):**

```
K13 - P13 = 4 - 4 = 0 EA
```

**MH Remaining (S13):**

```
O13 - R13 = 8 - 8 = 0 MH
```

**% Complete (T13):**

```
R13 / O13 = 8 / 8 = 100%
```

### Roll-Up Logic

**Detail → Phase → WBS**

Progress rolls up the hierarchy:

1. **Detail Level (D):**
   - % Complete calculated from earned MH vs. total MH

2. **Phase Level (P):**
   - % Complete = SUM(all child detail earned MH) / SUM(all child detail total MH)

3. **WBS Level (W):**
   - % Complete = SUM(all child phase earned MH) / SUM(all child phase total MH)

**Example:**

```
W: 10000 MOBILIZE
├─ P: 10001 EQUIPMENT SETUP (13 MH total)
│  ├─ D: TOOLS (5 MH, 5 earned) = 100%
│  └─ D: EQUIPMENT (8 MH, 8 earned) = 100%
│  Phase % = 13/13 = 100%
└─ P: 10002 TRAILER SETUP (10 MH total)
   └─ D: TOOL TRAILER (10 MH, 10 earned) = 100%
   Phase % = 10/10 = 100%

WBS % = (13 + 10) / (13 + 10) = 23/23 = 100%
```

---

## User Workflows

### Workflow 1: Daily Quantity Entry (Primary Use Case)

**User:** Field Supervisor / Foreman **Frequency:** Daily (end of shift) **Duration:** 5-10 minutes

**Steps:**

1. **Open Momentum**
   - App opens to "Enter Progress" screen

2. **Select Date**
   - Defaults to today's date
   - Can use calendar picker to select different date

3. **View Work Items**
   - See list of active work items (Detail level)
   - Grouped by WBS → Phase hierarchy
   - Filter by status (in progress, not started, completed)

4. **Enter Quantities**
   - For each item worked on today:
     - Tap/click the item
     - Enter quantity completed
     - See instant feedback:
       - Previous total: "3 EA completed before today"
       - Today's entry: "1 EA"
       - New total: "4 EA (100%)"
       - Remaining: "0 EA"

5. **Validate & Submit**
   - System validates:
     - Not exceeding estimate
     - Reasonable quantity (not 1000x normal)
   - Shows warnings if needed
   - User confirms and submits

6. **Confirmation**
   - Success message
   - Option to enter more dates
   - Option to view dashboard

**Edge Cases:**

- **Over-reporting:** User enters more than estimated
  - Show warning: "You've entered 5 EA, but only 4 remain. Adjust quantity or update estimate?"
- **Duplicate Entry:** User already entered data for this date
  - Show existing entry, allow edit/append
- **Offline:** No internet connection
  - Save locally, sync when online

---

### Workflow 2: Progress Dashboard Review

**User:** Project Manager **Frequency:** Weekly (Monday morning) **Duration:** 10-15 minutes

**Steps:**

1. **Open Momentum**
   - App opens to Dashboard

2. **View High-Level Status**
   - See all WBS items as cards
   - Color-coded by status:
     - 🟢 Green: 80-100% complete
     - 🟡 Yellow: 50-79% complete
     - 🟠 Orange: 20-49% complete
     - 🔴 Red: 0-19% complete
   - Key metrics visible:
     - % Complete
     - MH Earned / Total MH
     - Days remaining (if schedule data available)

3. **Drill Down into WBS**
   - Click "MOBILIZE" card
   - See all phases under MOBILIZE
   - Identify which phases are lagging

4. **Review Detail Items**
   - Click "EQUIPMENT SETUP" phase
   - See all detail work items
   - View daily entries in timeline
   - Identify patterns (e.g., "no progress on Wednesdays")

5. **View Charts**
   - Earned Value chart (planned vs. actual)
   - Burn-down chart (MH remaining over time)
   - Daily productivity chart (MH earned per day)

6. **Export Report**
   - Click "Export to Excel"
   - System generates file matching Excel layout
   - Save for stakeholder distribution

---

### Workflow 3: Project Setup (Import Estimate)

**User:** Project Manager / Project Controls **Frequency:** Once per project **Duration:** 15-20
minutes

**Steps:**

1. **Create Project**
   - Enter project metadata:
     - Proposal number
     - Job number
     - Name
     - Owner
     - Location
     - Start date

2. **Import Estimate Data**
   - Option A: Upload Excel file from MCP
   - Option B: Copy/paste from MCP
   - Option C: Manual entry (not recommended)

3. **Validate Import**
   - System parses data
   - Shows preview of hierarchy:
     - 8 WBS items
     - 77 Phase items
     - 321 Detail items
   - Validates:
     - All detail items have quantities and MH
     - Hierarchy is valid (no orphan items)
     - Units are recognized

4. **Confirm & Save**
   - User reviews and confirms
   - System creates database records
   - Project is ready for progress entry

---

### Workflow 4: Edit Estimate (Change Order)

**User:** Project Manager **Frequency:** As needed (change orders) **Duration:** 5-10 minutes

**Steps:**

1. **Navigate to Project Settings**
   - Click "Edit Estimate"

2. **Modify Item**
   - Find the item to change
   - Update quantity, MH, or description
   - System warns if item already has progress:
     - "This item has 3 EA completed. Changing estimate to 5 EA will update % complete."

3. **Add New Items**
   - Click "Add Detail Item"
   - Select parent Phase
   - Enter quantity, unit, MH
   - System recalculates Phase and WBS totals

4. **Remove Items**
   - Mark item as deleted
   - System warns if progress exists:
     - "This item has 2 EA completed. Are you sure you want to delete?"
   - Option to archive instead of delete

5. **Save Changes**
   - System recalculates all progress percentages
   - Audit log records change

---

## Feature Requirements

### Phase 1: MVP (Minimum Viable Product)

**Must-Have for Launch:**

#### 1. Project Management

- ✅ Create new project
- ✅ Import estimate data (WBS hierarchy, quantities, man-hours)
- ✅ View project metadata (name, owner, location, dates)
- ✅ Edit estimate (add/modify/delete items)

#### 2. Progress Entry

- ✅ Daily quantity entry interface
- ✅ Date picker (defaults to today)
- ✅ View work items grouped by WBS → Phase
- ✅ Enter quantities for multiple items at once
- ✅ Real-time validation:
  - Can't exceed estimated quantity
  - Can't enter negative numbers
  - Warnings for unusual entries

#### 3. Progress Calculations

- ✅ Auto-calculate:
  - Qty Complete
  - Qty Remaining
  - MH Earned
  - MH Remaining
  - % Complete
- ✅ Roll-up calculations (Detail → Phase → WBS)
- ✅ Weekly aggregations

#### 4. Dashboard & Reporting

- ✅ WBS-level dashboard (card view)
- ✅ Phase drill-down (list view)
- ✅ Detail drill-down (table view)
- ✅ Progress bars and % complete indicators
- ✅ Color-coded status (green/yellow/orange/red)

#### 5. Data Export

- ✅ Export to Excel (matching current format exactly)
- ✅ Export sections:
  - Scope breakdown
  - Estimate basis
  - Progress calculations
  - Daily entries
  - Weekly summaries

#### 6. Data Management

- ✅ Save progress entries to database
- ✅ Edit previous entries
- ✅ View entry history (audit trail)

---

### Phase 2: Enhanced Features

**Nice-to-Have (Post-MVP):**

#### 1. Visualization

- ⏳ Earned Value chart (S-curve)
- ⏳ Burn-down chart (MH remaining over time)
- ⏳ Daily/weekly productivity charts
- ⏳ Gantt chart (if schedule data available)

#### 2. Predictive Analytics

- ⏳ Forecast completion date (based on burn rate)
- ⏳ Identify lagging activities
- ⏳ Anomaly detection (unusual qty entries)
- ⏳ Resource forecasting

#### 3. Collaboration

- ⏳ Multi-user real-time editing (Supabase subscriptions)
- ⏳ Activity feed ("John entered 12 SF at 2:45 PM")
- ⏳ Comments on work items
- ⏳ Notifications (Slack/Teams integration)

#### 4. Mobile App

- ⏳ iOS/Android native apps
- ⏳ Offline mode with sync
- ⏳ Camera integration (photo documentation)
- ⏳ Voice entry (dictate quantities)

#### 5. Advanced Reporting

- ⏳ Custom report builder
- ⏳ PDF generation (branded reports)
- ⏳ Email digests (daily/weekly summary)
- ⏳ API for third-party integrations

#### 6. Permissions & Roles

- ⏳ Role-based access control:
  - Field Worker: Can only enter progress
  - Supervisor: Can enter and view dashboard
  - PM: Can edit estimate and full access
  - Executive: Read-only dashboard
- ⏳ Multi-project support
- ⏳ Multi-organization support

---

## Data Model

### Database Schema (Supabase/Postgres)

#### Table: `projects`

Stores project-level metadata.

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  proposal_number TEXT,
  job_number TEXT,
  name TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  location TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT DEFAULT 'active', -- active, on_hold, completed, archived
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);
```

---

#### Table: `wbs_items`

Stores the 3-level hierarchy (WBS, Phase, Detail).

```sql
CREATE TABLE wbs_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES wbs_items(id), -- null for WBS level
  level TEXT NOT NULL, -- 'W', 'P', or 'D'
  wbs_code TEXT NOT NULL, -- e.g., '10000'
  phase_code TEXT, -- e.g., '10001' (null for WBS level)

  -- Metadata (from estimate)
  description TEXT NOT NULL,
  size TEXT,
  flc TEXT,
  spec TEXT,
  insulation TEXT,
  insulation_size TEXT,
  sheet_number TEXT,

  -- Only populated for Detail (D) level
  quantity DECIMAL(10,2),
  unit TEXT, -- EA, SF, LF, CRAFT, etc.
  craft_mh DECIMAL(10,2),
  weld_mh DECIMAL(10,2),
  total_mh DECIMAL(10,2), -- craft_mh + weld_mh

  -- Display order
  sort_order INTEGER,

  -- Status
  is_deleted BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_wbs_items_project ON wbs_items(project_id);
CREATE INDEX idx_wbs_items_parent ON wbs_items(parent_id);
CREATE INDEX idx_wbs_items_level ON wbs_items(level);
```

**Hierarchy Example:**

```
Row 1: { id: A, parent_id: null, level: 'W', wbs_code: '10000', description: 'MOBILIZE' }
Row 2: { id: B, parent_id: A,    level: 'P', wbs_code: '10000', phase_code: '10001', description: 'EQUIPMENT SETUP' }
Row 3: { id: C, parent_id: B,    level: 'D', wbs_code: '10000', phase_code: '10001', description: 'TOOLS', quantity: 1, unit: 'EA', total_mh: 5 }
Row 4: { id: D, parent_id: B,    level: 'D', wbs_code: '10000', phase_code: '10001', description: 'EQUIPMENT', quantity: 4, unit: 'EA', total_mh: 8 }
```

---

#### Table: `progress_entries`

Stores daily quantity entries (the only user input).

```sql
CREATE TABLE progress_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wbs_item_id UUID NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  quantity_completed DECIMAL(10,2) NOT NULL,
  notes TEXT,

  -- Audit trail
  entered_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate entries
  UNIQUE(wbs_item_id, entry_date, entered_by)
);

-- Indexes
CREATE INDEX idx_progress_entries_item ON progress_entries(wbs_item_id);
CREATE INDEX idx_progress_entries_date ON progress_entries(entry_date);
```

**Example:**

```
{ wbs_item_id: C (TOOLS), entry_date: '2025-06-23', quantity_completed: 1, entered_by: user_123 }
{ wbs_item_id: D (EQUIPMENT), entry_date: '2025-06-23', quantity_completed: 1, entered_by: user_123 }
{ wbs_item_id: D (EQUIPMENT), entry_date: '2025-06-24', quantity_completed: 1, entered_by: user_123 }
```

---

#### Table: `progress_snapshots` (Materialized View)

Stores pre-calculated progress metrics for fast queries.

```sql
CREATE TABLE progress_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wbs_item_id UUID NOT NULL REFERENCES wbs_items(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,

  -- Cumulative totals (as of snapshot_date)
  qty_complete DECIMAL(10,2),
  qty_remaining DECIMAL(10,2),
  mh_earned DECIMAL(10,2),
  mh_remaining DECIMAL(10,2),
  percent_complete DECIMAL(5,2), -- 0.00 to 100.00

  -- Weekly values (for the week containing snapshot_date)
  week_start_date DATE,
  week_qty_complete DECIMAL(10,2),
  week_mh_earned DECIMAL(10,2),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(wbs_item_id, snapshot_date)
);

-- Indexes
CREATE INDEX idx_progress_snapshots_item ON progress_snapshots(wbs_item_id);
CREATE INDEX idx_progress_snapshots_date ON progress_snapshots(snapshot_date);
```

**Purpose:**

- Pre-calculated for dashboard performance
- Regenerated nightly or on-demand
- Enables fast queries for charts and reports

---

#### Views for Roll-Up Calculations

**View: `wbs_progress_summary`**

```sql
CREATE VIEW wbs_progress_summary AS
WITH RECURSIVE hierarchy AS (
  -- Anchor: Detail level items with progress
  SELECT
    wi.id,
    wi.project_id,
    wi.parent_id,
    wi.level,
    wi.wbs_code,
    wi.phase_code,
    wi.description,
    wi.total_mh,
    COALESCE(SUM(pe.quantity_completed), 0) AS qty_complete,
    wi.quantity - COALESCE(SUM(pe.quantity_completed), 0) AS qty_remaining,
    CASE
      WHEN wi.quantity > 0 THEN (COALESCE(SUM(pe.quantity_completed), 0) / wi.quantity) * wi.total_mh
      ELSE wi.total_mh
    END AS mh_earned
  FROM wbs_items wi
  LEFT JOIN progress_entries pe ON wi.id = pe.wbs_item_id
  WHERE wi.level = 'D' AND wi.is_deleted = FALSE
  GROUP BY wi.id, wi.quantity, wi.total_mh

  UNION ALL

  -- Recursive: Roll up to parent levels
  SELECT
    wi.id,
    wi.project_id,
    wi.parent_id,
    wi.level,
    wi.wbs_code,
    wi.phase_code,
    wi.description,
    SUM(h.total_mh) AS total_mh,
    SUM(h.qty_complete) AS qty_complete,
    SUM(h.qty_remaining) AS qty_remaining,
    SUM(h.mh_earned) AS mh_earned
  FROM wbs_items wi
  INNER JOIN hierarchy h ON wi.id = h.parent_id
  WHERE wi.is_deleted = FALSE
  GROUP BY wi.id
)
SELECT
  *,
  CASE WHEN total_mh > 0 THEN (mh_earned / total_mh) * 100 ELSE 100 END AS percent_complete,
  total_mh - mh_earned AS mh_remaining
FROM hierarchy;
```

---

## Technical Architecture

### Desktop Application (Tauri v2)

**Framework:** Tauri v2 + React 19 + Vite + TypeScript

**Key Features:**

- Native desktop performance
- Small bundle size (~5MB)
- Access to file system (for Excel import/export)
- Offline-capable
- Auto-updates

**Build Targets:**

- macOS (Intel + Apple Silicon)
- Windows (x64)
- Linux (optional)

---

### Frontend Architecture

**UI Framework:** React 19

**Styling:** Tailwind CSS v4 (design tokens from `.context/style-guide.md`)

**State Management:**

- **React Query (TanStack Query):** Server state (fetch/cache/sync with Supabase)
- **Zustand:** Client state (UI state, selections, filters)

**Component Library:**

- **shadcn/ui:** Base components (Button, Card, Input, etc.)
- Custom components for domain-specific UI (WBS tree, quantity entry form)

**Key Pages:**

1. **Dashboard Page**
   - WBS card grid
   - High-level metrics
   - Quick filters (status, date range)

2. **Progress Entry Page**
   - Date picker
   - Collapsible WBS/Phase tree
   - Quantity input form
   - Validation feedback

3. **Detail View Page**
   - Drill-down into single WBS/Phase
   - Table of detail items
   - Timeline view of daily entries

4. **Reports Page**
   - Export to Excel
   - Print preview
   - Custom report builder (Phase 2)

5. **Settings Page**
   - Project settings
   - Edit estimate
   - User preferences

---

### Backend Architecture

**Database:** Supabase (Postgres)

**Authentication:** Better Auth

**Real-Time:** Supabase subscriptions (for live collaboration in Phase 2)

**Storage:** Supabase storage (for file uploads, Excel imports)

**API Layer:**

- **Supabase Client:** Direct queries from frontend (RLS policies for security)
- **Server Actions (Next.js-style):** For complex calculations or imports

**Background Jobs:**

- Nightly snapshot generation (`progress_snapshots` table)
- Weekly email reports (Phase 2)

---

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         Momentum App                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐         ┌──────────────┐                  │
│  │   Dashboard  │         │   Progress   │                  │
│  │     View     │ ←─────→ │    Entry     │                  │
│  └──────────────┘         └──────────────┘                  │
│         ↑                         ↓                           │
│         │                         │                           │
│         │                   ┌──────────────┐                 │
│         └───────────────────│ React Query  │                 │
│                             │   (Cache)    │                 │
│                             └──────────────┘                 │
│                                     ↓                         │
└─────────────────────────────────────┼─────────────────────────┘
                                      ↓
                            ┌──────────────────┐
                            │  Supabase API    │
                            │   (Postgres)     │
                            └──────────────────┘
                                      ↓
                     ┌────────────────┴────────────────┐
                     ↓                                  ↓
           ┌──────────────────┐              ┌──────────────────┐
           │   wbs_items      │              │ progress_entries │
           │   projects       │              │ progress_snapshots│
           └──────────────────┘              └──────────────────┘
```

---

### Performance Considerations

**Large Datasets:**

- 321 detail items × 42 days = 13,482 potential data points
- Use virtualized tables (react-virtual) for long lists
- Lazy load detail items (only fetch when drilling down)
- Cache aggressively with React Query

**Real-Time Updates:**

- Debounce quantity inputs (500ms)
- Optimistic UI updates (instant feedback)
- Background sync with server

**Excel Export:**

- Generate on server (Node.js with `exceljs` library)
- Stream large files to avoid memory issues
- Show progress indicator for large exports

---

## UI/UX Design Principles

### Visual Hierarchy

**Momentum follows the design principles in `.context/design-principles.md`**

**Key Principles:**

1. **Clarity over cleverness**
   - Simple, obvious interfaces
   - No hidden features or Easter eggs

2. **Progressive disclosure**
   - Show summary first (WBS cards)
   - Drill down for details (Phase list → Detail table)

3. **Feedback is immediate**
   - Quantity input shows instant % complete update
   - Validation errors appear inline
   - Success states are celebratory (confetti on 100%)

4. **Color has meaning**
   - 🟢 Green: On track (80-100%)
   - 🟡 Yellow: Attention needed (50-79%)
   - 🟠 Orange: Behind schedule (20-49%)
   - 🔴 Red: Critical (0-19%)

5. **Touch-friendly**
   - Minimum 44px tap targets
   - Generous padding
   - Large input fields

---

### Key UI Patterns

#### 1. WBS Card Grid

```
┌─────────────────────────────────────────────────────────────┐
│                        Dashboard                             │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ 10000 MOBILIZE   │  │ 30000 CONCRETE   │                │
│  │ ████████████ 100%│  │ ████████░░░░  75%│                │
│  │ 88/88 MH Earned  │  │ 44/58 MH Earned  │                │
│  │ 🟢 Complete       │  │ 🟡 In Progress   │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ 40000 PIPING     │  │ 50000 STEEL      │                │
│  │ ████░░░░░░░░  40%│  │ ░░░░░░░░░░░░   0%│                │
│  │ 120/300 MH       │  │ 0/500 MH         │                │
│  │ 🟠 Behind        │  │ 🔴 Not Started   │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

#### 2. Progress Entry Form

```
┌─────────────────────────────────────────────────────────────┐
│              Enter Progress for June 23, 2025                │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  📅 [June 23, 2025 ▼]                        [Save Progress]│
│                                                               │
│  ▼ 10000 MOBILIZE                                            │
│    ▼ 10001 EQUIPMENT SETUP                                   │
│      ┌──────────────────────────────────────────────┐       │
│      │ ☑ TOOLS                                       │       │
│      │   Estimate: 1 EA | Total MH: 5               │       │
│      │   Qty: [1] ← entered                          │       │
│      │   Progress: 1/1 (100%) ████████████           │       │
│      └──────────────────────────────────────────────┘       │
│      ┌──────────────────────────────────────────────┐       │
│      │ ☐ EQUIPMENT                                   │       │
│      │   Estimate: 4 EA | Total MH: 8               │       │
│      │   Qty: [ ] Remaining: 4 EA                    │       │
│      │   Previous: 0 EA (0%)                         │       │
│      └──────────────────────────────────────────────┘       │
│                                                               │
│    ▶ 10002 TRAILER SETUP                                     │
│  ▶ 30000 CONCRETE                                            │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

#### 3. Detail Drill-Down Table

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back to Dashboard          10001 EQUIPMENT SETUP          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Progress: ████████████ 100% (13/13 MH Earned)              │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Description  │ Qty │ Unit │ Complete │ Remaining │ %   │ │
│  ├────────────────────────────────────────────────────────┤ │
│  │ TOOLS        │  1  │  EA  │    1     │     0     │ 100%│ │
│  │ EQUIPMENT    │  4  │  EA  │    4     │     0     │ 100%│ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  Timeline View:                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Jun 23  │ TOOLS: 1 EA         ███████                  │ │
│  │ Jun 24  │ EQUIPMENT: 1 EA     ██                        │ │
│  │ Jun 25  │ EQUIPMENT: 1 EA     ██                        │ │
│  │ Jun 26  │ EQUIPMENT: 1 EA     ██                        │ │
│  │ Jun 30  │ EQUIPMENT: 1 EA     ██                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

### Responsive Design

**Desktop First (Tauri):**

- Optimized for 1440px+ displays
- Multi-column layouts
- Keyboard shortcuts (Cmd+S to save, Cmd+E to export)

**Tablet Support (Future):**

- Responsive grid (cards stack on smaller screens)
- Touch-optimized inputs
- Simplified navigation

---

### Accessibility

**WCAG 2.1 AA Compliance:**

- Color contrast 4.5:1 minimum
- Keyboard navigation (tab order, focus states)
- Screen reader labels (ARIA attributes)
- Error messages announced (aria-live regions)

---

## Implementation Phases

### Phase 1: MVP (4-6 weeks)

**Sprint 1: Data Layer (Week 1-2)**

- Set up Supabase schema
- Create tables: `projects`, `wbs_items`, `progress_entries`
- Implement RLS policies
- Create sample seed data

**Sprint 2: Core UI (Week 2-4)**

- Dashboard page (WBS cards)
- Progress entry page (form + date picker)
- Detail drill-down page (table view)
- Navigation and routing

**Sprint 3: Calculations (Week 4-5)**

- Implement progress calculations (client-side)
- Weekly aggregations
- Roll-up logic (Detail → Phase → WBS)
- Real-time updates

**Sprint 4: Excel Export (Week 5-6)**

- Generate Excel file matching current layout
- All 6 sections
- Testing with real data
- Performance optimization

**Launch Criteria:**

- Can import estimate data
- Can enter daily quantities
- Dashboard shows accurate progress
- Excel export matches current format exactly
- No critical bugs

---

### Phase 2: Enhanced Features (4-6 weeks post-MVP)

**Sprint 5: Visualization (Week 7-8)**

- Earned value chart
- Burn-down chart
- Daily productivity chart
- Interactive tooltips

**Sprint 6: Collaboration (Week 9-10)**

- Real-time updates (Supabase subscriptions)
- Activity feed
- Multi-user conflict resolution

**Sprint 7: Mobile Optimization (Week 11-12)**

- Responsive layouts
- Touch optimizations
- Offline mode

---

### Phase 3: Advanced Features (Ongoing)

**Future Enhancements:**

- Predictive analytics
- Mobile native apps (iOS/Android)
- API for integrations
- Advanced reporting
- Multi-project dashboard
- Role-based permissions

---

## Appendix

### Glossary

**WBS (Work Breakdown Structure):** Top-level grouping of project scope (e.g., "MOBILIZE",
"CONCRETE")

**Phase:** Mid-level grouping under WBS (e.g., "EQUIPMENT SETUP", "CEMENTITIOUS GROUT")

**Detail:** Leaf-level work item with quantities (e.g., "TOOLS - 1 EA")

**MH (Man-Hours):** Labor hours required to complete work

**EA (Each):** Unit of measure - individual items (e.g., 4 EA = 4 pieces)

**SF (Square Feet):** Unit of measure for area

**LF (Linear Feet):** Unit of measure for length

**CRAFT:** Unit of measure for personnel (e.g., 11 CRAFT = 11 workers)

**Earned MH:** Man-hours credited based on completed quantities

**% Complete:** Progress percentage calculated as Earned MH / Total MH

**Roll-Up:** Aggregating child item values to parent levels (Detail → Phase → WBS)

---

### References

**Source Documents:**

- Email from stakeholder (requirements)
- Excel file: `1247 - Progress Tracking MASTER.xlsx`

**Related Systems:**

- **MCP (Estimator):** Provides estimate data (WBS, quantities, man-hours)
- **Precision (Desktop App):** Estimation tool in the same Truss monorepo

**Design Files:**

- `.context/design-principles.md` - UI/UX guidelines
- `.context/style-guide.md` - Brand colors, typography, spacing

---

### Sample Data

**Project: Nitron 2500T**

- Proposal: 1945.02
- Job: Nitron 2500T
- Owner: Linde
- Location: Sherman, Texas
- Start Date: June 23, 2025
- Total MH: ~3,500 (estimated based on 321 detail items)

**WBS Breakdown:**

1. 10000 MOBILIZE (88 MH)
2. 30000 CONCRETE (58.88 MH)
3. 40000 PIPING (estimated ~1,000 MH)
4. 50000 STRUCTURAL STEEL (estimated ~800 MH)
5. 60000 EQUIPMENT (estimated ~600 MH)
6. 70000 ELECTRICAL (estimated ~500 MH)
7. 80000 INSTRUMENTATION (estimated ~300 MH)
8. 90000 INSULATION (estimated ~200 MH)

---

### Change Log

| Date       | Version | Changes                  |
| ---------- | ------- | ------------------------ |
| 2025-11-12 | 1.0     | Initial document created |

---

**Document Owner:** Product Team **Last Updated:** November 12, 2025 **Status:** Living Document
(updates as features are implemented)

---

**End of Product Specification**
