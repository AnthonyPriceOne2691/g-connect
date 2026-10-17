/** Фейк Drive: помнит созданное и отправленное в корзину — этим и проверяем откат. */
export class FakeDriveClient {
  readonly created: { id: string; name: string; kind: string; parentId?: string }[] = [];
  readonly trashed: string[] = [];

  search(): Promise<{ files: never[]; incompleteBecause: never[] }> {
    return Promise.resolve({ files: [], incompleteBecause: [] });
  }

  create(
    kind: 'sheet' | 'doc' | 'folder',
    name: string,
    parentId?: string,
  ): Promise<{ id: string; name: string; url: string }> {
    const id = `FILE${this.created.length + 1}`;
    this.created.push({ id, name, kind, ...(parentId === undefined ? {} : { parentId }) });
    return Promise.resolve({ id, name, url: `https://drive.google.com/open?id=${id}` });
  }

  trash(fileId: string): Promise<void> {
    this.trashed.push(fileId);
    return Promise.resolve();
  }
}
