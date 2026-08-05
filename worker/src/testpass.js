/**
 * testpass.js — Kindness Card pass definition (step 2: now updatable).
 *
 * New vs step 1:
 * - webServiceURL + authenticationToken → devices register for updates
 * - a 'latest' back field whose changeMessage "%@" carries lock-screen
 *   notifications: PATCH sets its value, Apple shows the new value verbatim.
 */

export const DEFAULT_FIELDS = {
  due: 'Aug 11',
  promise: 'I promised an act of kindness',
  guest: 'Sarah',
  event: 'Test Event',
  acts: '0',
  movement: 'Act #247,801 of one million',
  latest: 'Welcome to the movement 💗',
};

export function buildPassJson(env, { serial, authToken, fields }) {
  const f = { ...DEFAULT_FIELDS, ...fields };
  return {
    formatVersion: 1,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    organizationName: env.ORG_NAME || 'All About Love',
    serialNumber: serial,
    description: 'Kindness Card (test)',
    logoText: 'All About Love',

    webServiceURL: env.BASE_URL,
    authenticationToken: authToken,

    backgroundColor: 'rgb(164, 19, 60)',
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 214, 224)',

    generic: {
      headerFields: [{ key: 'due', label: 'DUE', value: f.due, changeMessage: 'Due date: %@' }],
      primaryFields: [{ key: 'promise', label: 'MY PROMISE', value: f.promise }],
      secondaryFields: [
        { key: 'guest', label: 'GUEST', value: f.guest },
        { key: 'event', label: 'EVENT', value: f.event },
      ],
      auxiliaryFields: [
        { key: 'acts', label: 'ACTS DONE', value: f.acts },
        { key: 'movement', label: 'THE MOVEMENT', value: f.movement },
      ],
      backFields: [
        { key: 'latest', label: 'LATEST', value: f.latest, changeMessage: '%@' },
        {
          key: 'album',
          label: 'YOUR PHOTO — VIEW · SHARE · DOWNLOAD',
          value: f.barcode || f.photoUrl || 'https://allaboutlove.camera',
        },
        {
          key: 'about',
          label: 'ABOUT',
          value: 'One photo. One promise. One million acts of kindness.',
        },
      ],
    },

    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: f.barcode || f.photoUrl || 'https://allaboutlove.camera/p/test',
        messageEncoding: 'iso-8859-1',
        altText: 'scan to open your photo',
      },
    ],
  };
}
