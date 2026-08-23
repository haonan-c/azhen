/** Stable billing registry for Email business operations. */
export const EMAIL_BILLING_METHODS = {
  "EmailSession.getAddress": {
    methodKey: "email.mailbox.address.read.v1",
    rateUnit: "operation",
    quantity: 1,
  },
  "EmailHook.receiveEmail": {
    methodKey: "email.mailbox.message.receive.v1",
    rateUnit: "operation",
    quantity: 1,
  },
} as const;
