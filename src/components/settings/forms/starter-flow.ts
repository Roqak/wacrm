/**
 * Starting point for a new WhatsApp Form: one screen collecting name
 * and email, completed without a data endpoint. Field names line up
 * with the contact columns so the default mappings make sense.
 *
 * Meta versions Flow JSON and retires old versions; bump `version`
 * here when Meta's builder moves on. Meta validates on save and
 * reports anything it no longer accepts.
 */
export const STARTER_FLOW_JSON = {
  version: '7.0',
  screens: [
    {
      id: 'DETAILS',
      title: 'Your details',
      terminal: true,
      data: {},
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'details_form',
            children: [
              { type: 'TextInput', name: 'name', label: 'Full name', required: true },
              {
                type: 'TextInput',
                name: 'email',
                label: 'Email',
                'input-type': 'email',
                required: true,
              },
              {
                type: 'Footer',
                label: 'Submit',
                'on-click-action': {
                  name: 'complete',
                  payload: { name: '${form.name}', email: '${form.email}' },
                },
              },
            ],
          },
        ],
      },
    },
  ],
} as const;
