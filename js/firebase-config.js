// Firebase web config for Moon&Us. These values are public by design (they identify the project);
// access is protected by Firebase Auth + firestore.rules.
// Set to null to run in local-only mode (no accounts, no partner).
export default {
  apiKey: 'AIzaSyBiPOh18BnzyybTS7BBJYfZER5jjPMcpMg',
  authDomain: 'moon-and-us.firebaseapp.com',
  projectId: 'moon-and-us',
  storageBucket: 'moon-and-us.firebasestorage.app',
  messagingSenderId: '716053881982',
  appId: '1:716053881982:web:315f374f7223e4db6e642f',
  // Public Web Push (VAPID) key from Project settings, Cloud Messaging. Not a secret.
  vapidKey: 'BFkfOBb_t-jJ5bgeXvO_8eAthDR5_qedLz2QvccRMOA9_xm4AhYpcrHGHWayRpDzT1PG6V5Ori_j9QHPdoxEakw',
};
