/**
 * Firestore REST API client for Convex actions.
 *
 * WHY: Convex actions can `fetch()` external APIs but can't use the Firebase SDK.
 * This module provides authentication, paginated collection reads, filtered queries,
 * and recursive parsing of Firestore's encoded field format.
 *
 * @module
 */

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";
const AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";

// ============================================================================
// Authentication
// ============================================================================

/**
 * Get a Firebase ID token for Firestore access.
 *
 * WHY: Tries email/password auth first (if env vars set), falls back to
 * anonymous auth. Returns the ID token or empty string if using API-key-only mode.
 */
export async function getFirebaseAuthToken(apiKey: string): Promise<string> {
  const email = process.env.FIREBASE_AUTH_EMAIL;
  const password = process.env.FIREBASE_AUTH_PASSWORD;

  // Try email/password auth if credentials are configured
  if (email && password) {
    const res = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log("[auth] Firebase email auth succeeded");
      return data.idToken;
    }
    // Log the actual error so we can debug
    const errText = await res.text();
    console.warn(`[auth] Firebase email auth failed (${res.status}): ${errText.slice(0, 300)}`);
    console.warn("[auth] Falling back to API key mode");
  }

  // Return empty — we'll use ?key= parameter instead of Bearer token
  return "";
}

// ============================================================================
// Collection Reads
// ============================================================================

export interface FirestoreDocument {
  name: string;
  fields: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export interface FirestorePage {
  documents: FirestoreDocument[];
  nextPageToken?: string;
}

/** Fetch a single document by its ID via REST GET. */
export async function fetchDocumentById(
  projectId: string,
  collection: string,
  documentId: string,
  authToken: string
): Promise<FirestoreDocument | null> {
  const params = new URLSearchParams();
  if (!authToken) params.set("key", process.env.FIREBASE_API_KEY ?? "");

  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${collection}/${documentId}?${params}`;
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Firestore GET ${collection}/${documentId} failed (${res.status}): ${err.slice(0, 200)}`
    );
  }

  return res.json();
}

/** Fetch a page of documents from a Firestore collection. */
export async function fetchCollectionPage(opts: {
  projectId: string;
  collection: string;
  authToken: string;
  pageSize: number;
  pageToken?: string;
}): Promise<FirestorePage> {
  const params = new URLSearchParams({ pageSize: String(opts.pageSize) });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);
  // Use API key if no auth token
  if (!opts.authToken) params.set("key", process.env.FIREBASE_API_KEY ?? "");

  const url = `${FIRESTORE_BASE}/projects/${opts.projectId}/databases/(default)/documents/${opts.collection}?${params}`;
  const headers: Record<string, string> = {};
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Firestore fetch ${opts.collection} failed (${res.status}): ${err.slice(0, 200)}`
    );
  }

  const data = await res.json();
  return {
    documents: data.documents ?? [],
    nextPageToken: data.nextPageToken,
  };
}

/**
 * Fetch documents filtered by a field value using Firestore's structured query.
 *
 * WHY limit=5000: Firestore REST runQuery has a max of 10,000 but practical
 * limits are lower. We paginate with offset to get all results.
 */
export async function fetchByField(opts: {
  projectId: string;
  collection: string;
  authToken: string;
  fieldPath: string;
  fieldValue: string;
}): Promise<FirestoreDocument[]> {
  const apiKey = process.env.FIREBASE_API_KEY ?? "";
  const keyParam = !opts.authToken && apiKey ? `?key=${apiKey}` : "";
  const url = `${FIRESTORE_BASE}/projects/${opts.projectId}/databases/(default)/documents:runQuery${keyParam}`;

  // Paginate with offset to handle large collections (>10K docs per proposal)
  const allDocs: FirestoreDocument[] = [];
  let offset = 0;
  const PAGE = 5000;

  while (true) {
    const body = {
      structuredQuery: {
        from: [{ collectionId: opts.collection }],
        where: {
          fieldFilter: {
            field: { fieldPath: opts.fieldPath },
            op: "EQUAL",
            value: { stringValue: opts.fieldValue },
          },
        },
        limit: PAGE,
        offset,
      },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(
        `Firestore query ${opts.collection} failed (${res.status}): ${err.slice(0, 200)}`
      );
    }

    const results = await res.json();
    const docs = (results as Array<{ document?: FirestoreDocument }>)
      .filter((r) => r.document)
      .map((r) => r.document!);

    allDocs.push(...docs);

    if (docs.length < PAGE) break; // Last page
    offset += PAGE;
  }

  return allDocs;
}

// ============================================================================
// Document Parsing
// ============================================================================

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { mapValue: { fields: Record<string, FirestoreValue> } }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { timestampValue: string }
  | { referenceValue: string };

/** Recursively parse a Firestore REST value to a plain JS value. */
export function parseValue(val: FirestoreValue): unknown {
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return parseInt(val.integerValue, 10);
  if ("doubleValue" in val) return val.doubleValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("nullValue" in val) return null;
  if ("timestampValue" in val) return new Date(val.timestampValue).getTime();
  if ("referenceValue" in val) return val.referenceValue;
  if ("mapValue" in val) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields ?? {})) {
      obj[k] = parseValue(v);
    }
    return obj;
  }
  if ("arrayValue" in val) {
    return (val.arrayValue.values ?? []).map(parseValue);
  }
  return null;
}

/** Parse a full Firestore document into a plain object with its ID. */
export function parseDocument(doc: FirestoreDocument): { _fsId: string; [key: string]: unknown } {
  const id = doc.name.split("/").pop()!;
  const parsed: Record<string, unknown> = { _fsId: id };
  for (const [key, val] of Object.entries(doc.fields ?? {})) {
    parsed[key] = parseValue(val);
  }
  return parsed as { _fsId: string; [key: string]: unknown };
}
