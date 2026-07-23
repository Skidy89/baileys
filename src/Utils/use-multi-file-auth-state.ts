import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { packr } from './index.js'
import { makeKeyedMutex } from './make-mutex'

// We need to lock files due to the fact that we are using async functions to read and write files
// https://github.com/WhiskeySockets/Baileys/issues/794
// https://github.com/nodejs/node/issues/26338
// Keyed mutex: serializes access per file path and ref-counts its entries, so an
// idle path is freed instead of leaking a Mutex per key file for the process' life.
const fileMutex = makeKeyedMutex()

const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

/**
 * stores the full authentication state in a single folder.
 * Far more efficient than singlefileauthstate
 *
 * Again, I wouldn't endorse this for any production level use other than perhaps a bot.
 * Would recommend writing an auth state for use with a proper SQL or No-SQL DB
 * */
export const useMultiFileAuthState = async (
	folder: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)

		return fileMutex.mutex(filePath, async () => {
			try {
				await writeFile(filePath, packr.pack(data))
			} catch (error) {
				await removeData(file)
				throw error
			}
		})
	}

	const readData = async (file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		return await fileMutex.mutex(filePath, async () => {
			const data = await readFile(filePath).catch(() => null)
			if (!data) return null
			try {
				return packr.unpack(data)
			} catch {
				await unlink(filePath).catch(() => {})
				return null
			}
		})
	}

	const removeData = async (file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		return fileMutex.mutex(filePath, async () => {
			try {
				await unlink(filePath)
			} catch {}
		})
	}

	const folderInfo = await stat(folder).catch(() => {})
	if (folderInfo) {
		if (!folderInfo.isDirectory()) {
			throw new Error(
				`found something that is not a directory at ${folder}, either delete it or specify a different location`
			)
		}
	} else {
		await mkdir(folder, { recursive: true })
	}
	function decodeIdForType<T extends keyof SignalDataTypeMap>(type: T, encodedId: string): string {
		if (type === 'sender-key') {
			return encodedId.replace(/--/g, '::')
		}

		if (type === 'app-state-sync-key') {
			return encodedId.replace(/__/g, '/')
		}

		return encodedId
	}
	/**
	 * Iterate every file in the folder that belongs to `type`. Yields the
	 * decoded id (the same logical id callers passed to `get`/`set` originally)
	 * via {@link decodeIdForType}, plus the on-disk filename for read access.
	 */
	async function* iterateType<T extends keyof SignalDataTypeMap>(
		type: T
	): AsyncGenerator<{ id: string; filename: string }> {
		const entries = await readdir(folder)
		const prefix = `${fixFileName(type)}-`
		for (const filename of entries) {
			if (!filename.startsWith(prefix) || !filename.endsWith('.bin')) continue
			// Skip `.tmp` (in-flight writes) and `.bak` (rotated backups) artifacts.
			if (filename.endsWith('.tmp') || filename.endsWith('.bak')) continue
			const encodedId = filename.slice(prefix.length, -'.bin'.length)
			yield { id: decodeIdForType(type, encodedId), filename }
		}
	}
	const creds: AuthenticationCreds = (await readData('creds.bin')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					await Promise.all(
						ids.map(async id => {
							let value = await readData(`${type}-${id}.bin`)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						})
					)

					return data
				},
				set: async data => {
					const tasks: Promise<void>[] = []
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							const file = `${category}-${id}.bin`
							tasks.push(value ? writeData(value, file) : removeData(file))
						}
					}

					await Promise.all(tasks)
				},
				list: async function* <T extends keyof SignalDataTypeMap>(
					type: T
				): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
					for await (const entry of iterateType(type)) {
						let value: any = await readData(entry.filename)
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}

						if (value !== null && value !== undefined) {
							yield [entry.id, value as SignalDataTypeMap[T]] as const
						}
					}
				},
				listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
					for await (const entry of iterateType(type)) {
						yield entry.id
					}
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.bin')
		}
	}
}
