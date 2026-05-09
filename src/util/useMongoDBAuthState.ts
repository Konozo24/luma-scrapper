import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataSet,
} from "@whiskeysockets/baileys";
import { AnyBulkWriteOperation, Collection } from "mongodb";

export type AuthDoc = {
  _id: string;
  value: string;
  updatedAt: Date;
};

const CREDS_ID = "creds";

const keyId = (type: string, id: string) => `key:${type}:${id}`;

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

export async function useMongoDBAuthState(
  collection: Collection<AuthDoc>,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const credsDoc = await collection.findOne({ _id: CREDS_ID });
  console.log(
    `[WA AUTH DEBUG] useMongoDBAuthState collection=${collection.collectionName}, credsFound=${Boolean(credsDoc)}`,
  );
  const creds: AuthenticationCreds = credsDoc
    ? deserialize<AuthenticationCreds>(credsDoc.value)
    : initAuthCreds();

  const writeValue = async (id: string, value: unknown) => {
    await collection.updateOne(
      { _id: id },
      { $set: { value: serialize(value), updatedAt: new Date() } },
      { upsert: true },
    );
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: any } = {};
          if (!ids.length) return data;

          const docs = await collection
            .find({ _id: { $in: ids.map((id) => keyId(type, id)) } })
            .toArray();
          const byId = new Map(docs.map((doc) => [doc._id, doc]));

          for (const id of ids) {
            const doc = byId.get(keyId(type, id));
            if (!doc) {
              data[id] = undefined;
              continue;
            }

            let value = deserialize<any>(doc.value);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }

          return data;
        },
        set: async (data: SignalDataSet) => {
          const ops: AnyBulkWriteOperation<AuthDoc>[] = [];

          for (const category in data) {
            const categoryData = data[category as keyof SignalDataSet];
            if (!categoryData) continue;

            for (const id in categoryData) {
              const value = categoryData[id];
              const _id = keyId(category, id);

              if (value) {
                ops.push({
                  updateOne: {
                    filter: { _id },
                    update: {
                      $set: {
                        value: serialize(value),
                        updatedAt: new Date(),
                      },
                    },
                    upsert: true,
                  },
                });
              } else {
                ops.push({
                  deleteOne: {
                    filter: { _id },
                  },
                });
              }
            }
          }

          if (ops.length) {
            console.log(
              `[WA AUTH DEBUG] keys.set writing ${ops.length} ops to ${collection.collectionName}`,
            );
            await collection.bulkWrite(ops, { ordered: false });
          }
        },
      },
    },
    saveCreds: async () => {
      await writeValue(CREDS_ID, creds);
      console.log(
        `[WA AUTH DEBUG] saveCreds persisted in ${collection.collectionName} at ${new Date().toISOString()}`,
      );
    },
  };
}
