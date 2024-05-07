import { EventEmitter } from 'events';
import { ChangeStream, Collection, Db, Document, WithId } from 'mongodb';
import internal from 'stream';

export interface ChannelOptions {
  name?: string;
  mongoDb: Db;
  capped?: boolean
  size?: number
  max?: number
}

interface InternalChannelOptions {
  capped: boolean;
}

export class Channel extends EventEmitter {
  public closed: boolean;
  private options: InternalChannelOptions;
  private listening: boolean | null;
  private name: string;
  private db: Db;
  private collection!: Collection;
  private tableWatchStream?: ChangeStream<any, any>;
  private tailableCursor?: internal.Readable & AsyncIterable<WithId<Document>>;

  constructor(options: ChannelOptions) {
    super();

    this.db = options.mongoDb;
    this.options = {
      capped: options.capped,
      ...(options.capped && {
        size: options.size || 100000,
        max: options.max
    })
    };

    this.closed = false;
    this.listening = null;
    this.name = options.name || 'mubsub';
    this.setMaxListeners(Infinity);

    this.listen();
  }

  /**
   * Close the channel.
   *
   * @return {Channel} this
   * @api public
   */
  close(): Channel {
    this.closed = true;
    if (this.options.capped) {
      this.tailableCursor.destroy();
    } else {
      this.tableWatchStream.close();
    }

    this.removeAllListeners();
    return this;
  }

  async publish(params: { event: string; message: any }) {
    // console.log(`Channel publish()`, params);
    return this.collection.insertOne({
      ...params,
      expireAt: new Date(Date.now() + 1296000000),
    });
  }

  /**
   * Subscribe to an event.
   * If no event is passed - all events are subscribed.
   * @param args
   * @param {string} args.event if no event passed - all events are subscribed.
   * @param {Function} args.callback
   * @return {Object} unsubscribe function
   * @api public
   */
  subscribe({
              event = 'message',
              callback
            }: { event?: string; callback: (data: any) => void }): { unsubscribe: () => void } {

    this.on(event, callback);
    return {
      unsubscribe: () => {
        this.removeListener(event, callback);
      }
    };
  }

  async latest(latest: Document): Promise<Document> {

    let doc: Document = await this.collection
      .find(latest ? { _id: latest._id } : {})
      .sort({ $natural: 1 })
      .limit(1)
      .next();

    if (!doc) {
      doc = { type: 'init' };
      await this.collection.insertOne(doc);
    }
    return doc;
  }

  async listen(latest?: Document) {
    if (!this.collection) {
      await this.init();
    }
    latest = await this.latest(latest);

    if (this.options.capped) {
      this.useTailableCursor(latest);
    } else {
      this.useStream(latest)
    }

    this.listening = true;
    this.emit('ready', this.listening);
  }

  private useStream(latest) {
    this.tableWatchStream = this.collection
      .watch([
          {
              $match: {operationType: 'insert',  'fullDocument._id': { $gt: latest._id } }
          }
      ]);
        
    this.tableWatchStream.on('change', (doc) => {
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

  private useTailableCursor(latest) {
    this.tailableCursor = this.collection
      .find(
        { _id: { $gt: latest._id } },
        {
          noCursorTimeout: true,
          tailable: true,
          awaitData: true,
          sort: { $natural: 1 }
        }
      ).stream();

    this.tailableCursor.on(`data`, (doc: Document) => {
      // console.log(`tailableCursor.on('data')`, doc);
      const { event, message } = doc;
      if (event) {
        // console.log(`Channel.listen() emit event`, doc);
        this.emit(event, message);
        this.emit('message', message);
      }
    });
    this.tailableCursor.on(`error`, (error: any) => {
      console.error(`tailableCursor.on('error')`, error);
      this.emit('cursor-error', error);

    });
    this.tailableCursor.on(`end`, () => {
      // console.log(`tailableCursor.on('end')`, `cursor ended`);
      this.emit('cursor-end');
    });
    this.tailableCursor.on(`close`, () => {
      // console.log(`tailableCursor.on('close')`, `Cursor closed`);
      this.emit('cursor-close');
    });
  }

  private async init(): Promise<Collection> {
    // console.log(`Channel.init()`, { channelName: this.name });
    const collections = await this.db.collections();
    let collection = collections.find((c) => c.collectionName === this.name);
    if (!collection) {
      collection = await this.db.createCollection(this.name, this.options);
      if (!this.options.capped) {
        try {
          await this.db.admin().command({
            modifyChangeStreams: 1,
            database: this.db.databaseName,
            collection: this.name,
            enable: true,
          });

          await collection.createIndex(
            { expireAt: 1 },
            { expireAfterSeconds: 1296000 }
          );
        } catch (e) {
          console.log(e);
        }
      }
    }

    this.collection = collection;
    this.emit('collection', this.collection);
    return collection;
  }

  private ready(callback: () => void) {
    // console.log(`Channel.ready()`, { listening: !!this.listening });
    if (this.listening) {
      callback();
    } else {
      this.once('ready', callback);
    }
  }
}
