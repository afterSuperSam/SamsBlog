import { siteConfig } from '../config/site';
import type { MessageRecord } from './db';

export function isLongMessage(content: string) {
  return Array.from(content).length > siteConfig.discussion.collapsedContentCharacters || content.split('\n').length > siteConfig.discussion.textareaMaximumLines;
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

function disclosure(className: string, closedText: string, openedText: string) {
  const details = element('details', className); details.dataset.messageFold = '';
  const summary = element('summary');
  summary.append(element('span', 'message-collapse__closed', closedText), element('span', 'message-collapse__opened', openedText));
  details.append(summary); return details;
}

function messageBody(content: string) {
  const paragraph = element('p', '', content); paragraph.dataset.commentText = '';
  if (!isLongMessage(content)) return paragraph;
  const details = disclosure('message-collapse', '展开全文', '收起全文');
  details.querySelector('summary')!.prepend(element('span', 'message-collapse__preview', Array.from(content).slice(0, siteConfig.discussion.collapsedContentCharacters).join('')));
  details.append(paragraph); return details;
}

// 与首屏组件共用折叠条件和签名字形，发表后只替换列表，不触碰正在编辑的表单。
export function renderCommentList(list: HTMLElement, messages: MessageRecord[], publishedId?: number) {
  const makeMessage = (message: MessageRecord, parentId: number, reply = false) => {
    const node = element(reply ? 'div' : 'article', reply ? `message-reply${message.isAdmin ? ' is-owner' : ''}` : 'article-comment');
    node.id = `comment-${message.id}`; node.dataset.messageId = String(message.id); node.dataset.commentRoot = String(parentId); node.dataset.messageName = message.isAdmin ? 'SuperSam' : message.nickname;
    const header = element('header');
    if (message.isAdmin) {
      const signature = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      signature.setAttribute('class', 'message-owner-signature'); signature.setAttribute('role', 'img'); signature.setAttribute('aria-label', '站长 SuperSam');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#message-owner-signature'); signature.append(use); header.append(signature);
    } else header.append(element('b', '', message.nickname));
    if (!reply) {
      const date = element('time', '', new Date(message.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
      date.dateTime = message.createdAt; header.append(date);
    }
    const button = element('button', '', '回复'); button.type = 'button'; button.dataset.commentReply = String(parentId); button.dataset.commentMessage = String(message.id); button.dataset.commentName = node.dataset.messageName; header.append(button);
    node.append(header);
    if (message.quoteContent) {
      const quote = element('blockquote', 'comment-quote'); quote.append(element('b', '', `引用 ${message.quoteNickname}`), element('p', '', message.quoteContent)); node.append(quote);
    }
    node.append(messageBody(message.content)); return node;
  };
  list.replaceChildren(...messages.map((message) => {
    const article = makeMessage(message, message.id);
    const replies = message.replies || [];
    if (!replies.length) return article;
    const visible = siteConfig.discussion.visibleReplyCount;
    const group = element('div', 'message-replies'); group.append(...replies.slice(0, visible).map((reply) => makeMessage(reply, message.id, true))); article.append(group);
    if (replies.length > visible) {
      const more = disclosure('message-replies-more', `还有 ${replies.length - visible} 条回复`, '收起回复');
      const group = element('div', 'message-replies'); group.append(...replies.slice(visible).map((reply) => makeMessage(reply, message.id, true))); more.append(group); article.append(more);
    }
    return article;
  }));
  if (publishedId) {
    let node: HTMLElement | null = list.querySelector(`#comment-${publishedId}`);
    while (node && node !== list) { if (node instanceof HTMLDetailsElement) node.open = true; node = node.parentElement; }
  }
}
