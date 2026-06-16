import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { makeKeyedMutex } from './make-mutex'
import { packr } from './index.js'


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
				await writeFile(filePath, packr.pack(data), {
					encoding: 'utf-8',
					signal: AbortSignal.timeout(15000)
				})
				
			} catch (error) {
				await removeData(file)
				throw error
			}
		})
	}

	const readData = async (file: string) => {

		const filePath = join(folder, fixFileName(file)!)
		return await fileMutex.mutex(filePath, async () => {
				
			const data = await readFile(filePath, {
				signal: AbortSignal.timeout(15000)
			}).catch(() => null)
			if (!data) return null
			return packr.unpack(data)
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
				}
			}
		},
		saveCreds: async () => {
			return writeData(creds, 'creds.bin')
		}
	}
}