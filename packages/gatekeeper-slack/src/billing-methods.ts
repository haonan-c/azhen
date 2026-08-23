function operation(methodKey: string) {
  return { methodKey, rateUnit: "operation", quantity: 1 } as const;
}

/** Stable billing registry for Slack caller-visible reads. */
export const SLACK_BILLING_METHODS = {
  "SlackWorkspaceSession.getInfo": operation("slack.workspace.get-info"),
  "SlackWorkspaceSession.listChannels.next": operation("slack.workspace.channel.list-page"),
  "SlackWorkspaceSession.listDirectMessages.next": operation("slack.workspace.direct-message.list-page"),
  "SlackWorkspaceSession.listUsers.next": operation("slack.workspace.user.list-page"),
  "SlackWorkspaceSession.getUser": operation("slack.workspace.user.get"),
  "SlackWorkspaceSession.getConversation": operation("slack.workspace.conversation.get"),
  "SlackWorkspaceSession.search.next": operation("slack.workspace.message.search-page"),
  "SlackConversation.getInfo": operation("slack.conversation.get-info"),
  "SlackConversation.members.next": operation("slack.conversation.member.list-page"),
  "SlackConversation.listMessages.next": operation("slack.conversation.message.list-page"),
  "SlackConversation.getThread": operation("slack.conversation.thread.get"),
  "SlackConversation.search.next": operation("slack.conversation.message.search-page"),
  "SlackThread.getRoot": operation("slack.thread.get-root"),
  "SlackThread.listReplies": operation("slack.thread.reply.list"),
} as const;
