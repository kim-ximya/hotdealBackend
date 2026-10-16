import { interestKey, normalizeKeywords } from '../src/interests.js';

const $ = (id) => document.getElementById(id);

export class InterestView {
  #api;
  #onChange;
  #toast;
  #settings = null;
  #busy = false;

  constructor(api, { onChange, toast }) {
    this.#api = api;
    this.#onChange = onChange;
    this.#toast = toast;
    $('interest-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#save(() => {
        const [keyword] = normalizeKeywords([$('interest-keyword').value]);
        if (this.#settings.keywords.some((value) => interestKey(value) === interestKey(keyword))) throw new Error('이미 등록한 관심 품목입니다.');
        return { ...this.#value(), keywords: [...this.#settings.keywords, keyword] };
      }, '관심 품목을 등록했습니다.', true);
    });
    $('interest-notify-only').addEventListener('change', () => {
      const checked = $('interest-notify-only').checked;
      void this.#save(() => ({ ...this.#value(), notifyOnlyMatches: checked }), '알림 범위를 저장했습니다.');
    });
    void this.#initialize();
  }

  #value() { return { keywords: [...this.#settings.keywords], notifyOnlyMatches: this.#settings.notifyOnlyMatches }; }

  async #initialize() {
    try {
      this.#settings = await this.#api.interestSettings();
      this.#render();
      this.#onChange(this.#settings);
    } catch (error) { this.#showError(`관심 품목 설정을 불러오지 못했습니다: ${error.message}`); }
  }

  #showError(message) { $('interest-error').textContent = message; $('interest-error').hidden = false; }

  #controls() {
    const disabled = this.#busy || !this.#settings;
    for (const id of ['interest-keyword', 'interest-add', 'interest-notify-only']) $(id).disabled = disabled;
    for (const button of $('interest-keywords').querySelectorAll('button')) button.disabled = disabled;
  }

  async #save(next, message, clearInput = false) {
    if (this.#busy || !this.#settings) return;
    this.#busy = true;
    this.#controls();
    $('interest-error').hidden = true;
    try {
      this.#settings = await this.#api.setInterestSettings(next());
      this.#render();
      if (clearInput) $('interest-keyword').value = '';
      this.#onChange(this.#settings);
      this.#toast(message);
    } catch (error) {
      $('interest-notify-only').checked = this.#settings.notifyOnlyMatches;
      this.#showError(error.message);
    } finally {
      this.#busy = false;
      this.#controls();
      if (clearInput) $('interest-keyword').focus();
    }
  }

  #render() {
    const { keywords, notifyOnlyMatches, error } = this.#settings;
    $('interests-tab-count').textContent = keywords.length;
    $('interest-count').textContent = `${keywords.length} / 100개`;
    $('interest-notify-only').checked = notifyOnlyMatches;
    $('interest-notify-status').textContent = notifyOnlyMatches
      ? keywords.length ? '관심 품목과 일치하는 새 글만 알립니다.' : '등록한 품목이 없어 새 글 알림을 보내지 않습니다.'
      : '모든 새 글을 알립니다.';
    $('interest-empty').hidden = keywords.length > 0;
    const fragment = document.createDocumentFragment();
    for (const keyword of keywords) {
      const item = document.createElement('li');
      const label = document.createElement('span'); label.textContent = keyword;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `${keyword} 관심 품목 삭제`);
      remove.addEventListener('click', () => { void this.#save(() => ({ ...this.#value(),
        keywords: this.#settings.keywords.filter((value) => value !== keyword) }), '관심 품목을 삭제했습니다.'); });
      item.append(label, remove); fragment.append(item);
    }
    $('interest-keywords').replaceChildren(fragment);
    $('interest-error').hidden = !error;
    if (error) $('interest-error').textContent = error;
    this.#controls();
  }
}
