from collections import defaultdict
from fastapi import WebSocket

class WebSocketManager:
    def __init__(self):
        self.connections: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, websocket: WebSocket, channel: str):
        await websocket.accept()
        self.connections[channel].add(websocket)

    def disconnect(self, websocket: WebSocket, channel: str):
        self.connections[channel].discard(websocket)

    async def publish(self, event: dict, channels: set[str]):
        for channel in channels:
            dead = []
            for websocket in self.connections[channel]:
                try: await websocket.send_json(event)
                except Exception: dead.append(websocket)
            for websocket in dead: self.disconnect(websocket, channel)

manager = WebSocketManager()
