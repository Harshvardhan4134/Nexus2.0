import admin from "firebase-admin";

/**
 * Initializes Firebase Admin once. Prefer one of:
 * - Local: `FIRESTORE_EMULATOR_HOST` (e.g. 127.0.0.1:8080) + optional `FIREBASE_PROJECT_ID`
 * - CI / server: `FIREBASE_SERVICE_ACCOUNT_JSON` (full service account JSON string)
 * - GCP / ADC: `GOOGLE_APPLICATION_CREDENTIALS` path or metadata-based default credentials
 */
function initFirebaseAdmin(): void {
  if (admin.apps.length > 0) {
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID ?? "demo-nexus";

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId });
    return;
  }

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    const cred = JSON.parse(json) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return;
  }

  try {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  } catch {
    throw new Error(
      "Firebase Admin: set FIRESTORE_EMULATOR_HOST for the Firestore emulator, or FIREBASE_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }
}

initFirebaseAdmin();

export const firestore = admin.firestore();
export { admin as firebaseAdmin };

export * from "./schema";
