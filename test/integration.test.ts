import { Db } from "mongodb";
import { MubSub } from "../src";
import mongoose from "mongoose";

const {
  MONGODB_URI = "mongodb://root:secret@127.0.0.1:27017/?authSource=admin",
} = process.env;

const COLLECTION_NAME = "mubsub";

const getTimestamp = (): { timestamp: string } => ({
  timestamp: new Date().toISOString(),
});

const timeout = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

describe("Channel", () => {
  let mongoDb: Db;
  let mubsub: MubSub;

  beforeAll(async () => {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to database successfully");
    mongoDb = mongoose.connection.db! as any;
  });

  beforeEach(async () => {
    try {
      await mongoDb!.dropCollection(COLLECTION_NAME);
    } catch {
      // collection may not exist yet
    }

    await new Promise<void>((resolve) => {
      mubsub = new MubSub({
        mongoDb: mongoDb as any,
        capped: true,
      });
      mubsub.on("ready", () => resolve());
    });
  });

  afterEach(async () => {
    mubsub.close();
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it("unsubscribes properly", async () => {
    const callback = jest.fn();
    const event = `a`;
    const subscription = mubsub.subscribe({ event, callback });
    await mubsub.publish({ event, message: { id: 1 } });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    await mubsub.publish({ event, message: { id: 2 } });
    await mubsub.publish({ event, message: { id: 3 } });
    await mubsub.publish({ event, message: { id: 4 } });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes if channel is closed", async () => {
    const callback = jest.fn();
    const event = `a`;
    mubsub.subscribe({ event, callback });
    await mubsub.publish({ event, message: getTimestamp() });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(1);
    await mubsub.publish({ event, message: getTimestamp() });
    await timeout(50);
    mubsub.close();
    await mubsub.publish({ event, message: getTimestamp() });
    await mubsub.publish({ event, message: getTimestamp() });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("should not emit old events to a second channel with same name", async () => {
    const callback = jest.fn();
    const callback2 = jest.fn();
    const event = `b`;
    const message1 = { id: 1 };
    const message2 = { id: 2 };
    mubsub.subscribe({ event, callback });
    await mubsub.publish({ event, message: message1 });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(1);

    const mubsub2 = new MubSub({
      mongoDb: mongoDb as any,
      capped: true,
    });
    await timeout(500);
    const subscription2 = mubsub.subscribe({ event, callback: callback2 });
    await mubsub.publish({ event, message: message2 });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback2).toHaveBeenCalledTimes(1);
    await mubsub2.publish({ event, message: { id: 3 } });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback2).toHaveBeenCalledTimes(2);
    mubsub2.close();
    await timeout(50);
  });

  it("can subscribe and publish different events", async () => {
    const callback = jest.fn();
    const callback2 = jest.fn();
    const callback3 = jest.fn();
    const event = `a`;
    const event2 = `b`;
    const event3 = `c`;
    mubsub.subscribe({ event, callback });
    mubsub.subscribe({ event: event2, callback: callback2 });
    mubsub.subscribe({ event: event3, callback: callback3 });
    await mubsub.publish({ event, message: { id: 1 } });
    await mubsub.publish({ event: event2, message: { id: 2 } });
    await mubsub.publish({ event: event3, message: { id: 3 } });
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(callback2).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(callback3).toHaveBeenCalledTimes(1);
    expect(callback3).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });

  it("gets lots of subscribed data fast enough", async () => {
    const message = { a: "a]".repeat(5000) };
    const messages = 5000;
    const event = `a`;
    const callback = jest.fn();
    mubsub.subscribe({ event, callback });
    for (let i = 0; i < messages; i++) {
      await mubsub.publish({ event, message });
    }
    await timeout(50);
    expect(callback).toHaveBeenCalledTimes(messages);
  }, 10000);
});
