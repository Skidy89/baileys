import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import { UserFacingSocketConfig } from '../Types'
import { makeMessagesRecvSocket } from './messages-recv'


// export the last socket layer
const makeWASocket = (config: UserFacingSocketConfig) => (
	makeMessagesRecvSocket({
		...DEFAULT_CONNECTION_CONFIG,
		...config
	})
)

export default makeWASocket