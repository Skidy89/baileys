import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import { cleanupQueues } from '../Signal/Group/queue-job'
import { UserFacingSocketConfig } from '../Types'
import { makeMessagesRecvSocket } from './messages-recv'


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