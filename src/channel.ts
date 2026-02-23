import { EventEmitter } from 'events';
import { ChangeStream, Collection, CreateCollectionOptions, Db, Document, FindCursor, WithId } from 'mongodb';

export interface ChannelOptions {
  name?: string;
  mongoDb: Db;
  capped?: boolean;
  size?: number;
  max?: number;
}

export class Channel extends EventEmitter {
  public closed = false;
  private listening: boolean | null = null;
  private readonly name: string;
  private readonly db: Db;
  private readonly capped: boolean;
  private readonly size: number;
  private readonly max?: number;
  private collection!: Collection;
  private tableWatchStream?: ChangeStream;
  private tailableCursor?: FindCursor<WithId<Document>>;

  constructor(options: ChannelOptions) {
    super();

    this.db = options.mongoDb;
    this.capped = options.capped ?? false;
    this.size = options.size ?? 100000;
    this.max = options.max;
    this.name = options.name ?? 'mubsub';
    this.setMaxListeners(Infinity);

    this.listen();
  }

  close(): Channel {
    this.closed = true;

    if (this.capped) {
      this.tailableCursor?.close();
    } else {
      this.tableWatchStream?.close();
    }

    this.removeAllListeners();
    return this;
  }

  async publish(params: { event: string; message: unknown }): Promise<void> {
    await this.collection.insertOne({
      ...params,
      expireAt: new Date(Date.now() + 1_296_000_000),
    });
  }

  subscribe({
    event = 'message',
    callback,
  }: {
    event?: string;
    callback: (data: unknown) => void;
  }): { unsubscribe: () => void } {
    this.on(event, callback);
    return {
      unsubscribe: () => {
        this.removeListener(event, callback);
      },
    };
  }

  async listen(latest?: Document): Promise<void> {
    if (!this.collection) {
      await this.init();
    }
    latest = await this.latest(latest);

    if (this.capped) {
      this.consumeTailableCursor(latest);
    } else {
      this.useStream(latest);
    }

    this.listening = true;
    this.emit('ready', this.listening);
  }

  private async latest(doc?: Document): Promise<Document> {
    let result: Document | null = await this.collection
      .find(doc ? { _id: doc._id } : {})
      .sort({ $natural: 1 })
      .limit(1)
      .next();

    if (!result) {
      result = { type: 'init' };
      await this.collection.insertOne(result);
    }
    return result;
  }

  // AWS DocumentDB compatibility: uses change streams instead of tailable cursors
  private useStream(latest: Document): void {
    this.tableWatchStream = this.collection.watch([
      {
        $match: {
          operationType: 'insert',
          'fullDocument._id': { $gt: latest._id },
        },
      },
    ]);

    this.tableWatchStream.on('change', (doc) => {
      if (!('fullDocument' in doc) || !doc.fullDocument) return;

      const { event, message } = doc.fullDocument;
      if (event) {
        this.emit(event, message);
        this.emit('message', message);
      }
    });

    this.tableWatchStream.on('error', (error) => {
      console.error(`tableWatchStream.on('error')`, error);
      this.emit('cursor-error', error);
    });

    this.tableWatchStream.on('end', () => {
      this.emit('cursor-end');
    });

    this.tableWatchStream.on('close', () => {
      this.emit('cursor-close');
    });
  }

  private consumeTailableCursor(latest: Document): void {
    this.tailableCursor = this.collection.find(
      { _id: { $gt: latest._id } },
      {
        tailable: true,
        awaitData: true,
        noCursorTimeout: true,
        sort: { $natural: 1 },
      },
    );

    this.iterateCursor(this.tailableCursor);
  }

  private async iterateCursor(cursor: FindCursor<WithId<Document>>): Promise<void> {
    try {
      for await (const doc of cursor) {
        if (this.closed) break;
        const { event, message } = doc;
        if (event) {
          this.emit(event as string, message);
          this.emit('message', message);
        }
      }
      this.emit('cursor-end');
    } catch (error) {
      if (!this.closed) {
        console.error('tailableCursor iteration error', error);
        this.emit('cursor-error', error);
      }
    } finally {
      this.emit('cursor-close');
    }
  }

  private async init(): Promise<Collection> {
    const collections = await this.db.collections();
    let collection = collections.find((c) => c.collectionName === this.name);

    if (!collection) {
      const createOpts: CreateCollectionOptions = this.capped
        ? { capped: true, size: this.size, max: this.max }
        : {};

      collection = await this.db.createCollection(this.name, createOpts);

      if (!this.capped) {
        try {
          await this.db.admin().command({
            modifyChangeStreams: 1,
            database: this.db.databaseName,
            collection: this.name,
            enable: true,
          });

          await collection.createIndex(
            { expireAt: 1 },
            { expireAfterSeconds: 1_296_000 },
          );
        } catch (e) {
          console.error('Failed to configure change streams or TTL index', e);
        }
      }
    }

    this.collection = collection;
    this.emit('collection', this.collection);
    return collection;
  }
}
