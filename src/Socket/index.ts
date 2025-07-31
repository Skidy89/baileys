import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import { UserFacingSocketConfig } from '../Types'
import { makeMessagesRecvSocket } from './messages-recv'
import { cleanupQueues } from '../../WASignalGroup/queue_job'

// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => (
	makeMessagesRecvSocket({
		...DEFAULT_CONNECTION_CONFIG,
		...config
	})
)
export const cleanQueues = () => {
	cleanupQueues()
}

export default makeWASocket