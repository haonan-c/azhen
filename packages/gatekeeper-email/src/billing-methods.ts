/** Stable billing registry for Email business operations. */
export const EMAIL_BILLING_METHODS = {
  "EmailHook.receiveEmail": {
    methodKey: "email.incoming.receive",
    rateUnit: "operation",
    quantity: 1,
  },
} as const;
