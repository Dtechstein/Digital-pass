/**
 * testpass.js — the static crimson Kindness test card (build-order step 1).
 * No web service, no updates yet: prove signing + "Add to Wallet" first.
 */

export function makeTestPassJson(env, serialNumber) {
  return {
    formatVersion: 1,
    passTypeIdentifier: env.APPLE_PASS_TYPE_ID,
    teamIdentifier: env.APPLE_TEAM_ID,
    organizationName: env.ORG_NAME || 'All About Love',
    serialNumber,
    description: 'Kindness Card (test)',
    logoText: 'All About Love',

    backgroundColor: 'rgb(164, 19, 60)',
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 214, 224)',

    generic: {
      headerFields: [
        { key: 'due', label: 'DUE', value: 'Aug 11' },
      ],
      primaryFields: [
        { key: 'promise', label: 'MY PROMISE', value: 'I promised an act of kindness' },
      ],
      secondaryFields: [
        { key: 'guest', label: 'GUEST', value: 'Sarah' },
        { key: 'event', label: 'EVENT', value: 'Test Event' },
      ],
      auxiliaryFields: [
        { key: 'acts', label: 'ACTS DONE', value: '0' },
        { key: 'movement', label: 'THE MOVEMENT', value: 'Act #247,801 of one million' },
      ],
      backFields: [
        {
          key: 'album',
          label: 'YOUR PHOTOS',
          value: 'https://allaboutlove.camera',
        },
        {
          key: 'about',
          label: 'ABOUT',
          value:
            'One photo. One promise. One million acts of kindness. This is a static test card — updates and notifications arrive in step 2.',
        },
      ],
    },

    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: 'https://allaboutlove.camera/p/test',
        messageEncoding: 'iso-8859-1',
        altText: 'allaboutlove.camera/p/test',
      },
    ],
  };
}
