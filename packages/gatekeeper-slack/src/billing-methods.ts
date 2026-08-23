function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Slack caller-visible reads. */
export const SLACK_BILLING_METHODS = {
  "SlackWorkspaceSession.getInfo": operation("slack.workspace.info.read.v1"),
  "SlackWorkspaceSession.listChannels": operation("slack.workspace.channels.list.v1"),
  "SlackWorkspaceSession.listDirectMessages": operation("slack.workspace.direct_messages.list.v1"),
  "SlackWorkspaceSession.listUsers": operation("slack.workspace.users.list.v1"),
  "SlackWorkspaceSession.getUser": operation("slack.workspace.user.read.v1"),
  "SlackWorkspaceSession.search": operation("slack.workspace.messages.search.v1"),
  "SlackConversation.getInfo": operation("slack.conversation.info.read.v1"),
  "SlackConversation.members": operation("slack.conversation.members.list.v1"),
  "SlackConversation.listMessages": operation("slack.conversation.messages.list.v1"),
  "SlackConversation.search": operation("slack.conversation.messages.search.v1"),
  "SlackThread.getRoot": operation("slack.thread.root.read.v1"),
  "SlackThread.listReplies": operation("slack.thread.replies.list.v1"),
} as const;
