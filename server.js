'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: '*'
	}
});

// Serve static files
app.use(express.static('public'));

// Game constants
const TICK_RATE = 60; // simulation ticks per second
const BROADCAST_RATE = 20; // state updates per second
const MAP_HALF_SIZE = 1200; // world bounds: [-MAP_HALF_SIZE, MAP_HALF_SIZE]
const PLAYER_SPEED = 220; // units per second
const PLAYER_RADIUS = 24;
const BULLET_SPEED = 600; // units per second
const BULLET_RADIUS = 6;
const BULLET_LIFETIME_MS = 2000;
const SHOOT_COOLDOWN_MS = 350;
const MAX_HEALTH = 100;

/** @type {Record<string, any>} */
const players = {};
/** @type {Array<any>} */
const bullets = [];

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function distanceSquared(ax, ay, bx, by) {
	const dx = ax - bx;
	const dy = ay - by;
	return dx * dx + dy * dy;
}

function spawnPosition() {
	const margin = 200;
	const x = (Math.random() * 2 - 1) * (MAP_HALF_SIZE - margin);
	const y = (Math.random() * 2 - 1) * (MAP_HALF_SIZE - margin);
	return { x, y };
}

io.on('connection', (socket) => {
	const { x, y } = spawnPosition();
	players[socket.id] = {
		id: socket.id,
		x,
		y,
		angle: 0,
		score: 0,
		health: MAX_HEALTH,
		inputs: { up: false, down: false, left: false, right: false, aimingAngle: 0, shooting: false },
		lastShotAt: 0
	};

	socket.emit('init', { id: socket.id, mapHalfSize: MAP_HALF_SIZE, maxHealth: MAX_HEALTH });

	socket.on('input', (data) => {
		const p = players[socket.id];
		if (!p) return;
		// Trust but clamp inputs
		p.inputs.up = !!data.up;
		p.inputs.down = !!data.down;
		p.inputs.left = !!data.left;
		p.inputs.right = !!data.right;
		p.inputs.shooting = !!data.shooting;
		if (typeof data.aimingAngle === 'number' && isFinite(data.aimingAngle)) {
			p.inputs.aimingAngle = data.aimingAngle;
		}
	});

	socket.on('disconnect', () => {
		delete players[socket.id];
	});
});

let lastTickTs = Date.now();
setInterval(() => {
	const now = Date.now();
	let dt = (now - lastTickTs) / 1000; // seconds
	if (dt > 0.1) dt = 0.1; // clamp huge frame skips
	lastTickTs = now;

	// Update players from inputs
	for (const id in players) {
		const p = players[id];
		let moveX = 0;
		let moveY = 0;
		if (p.inputs.up) moveY += 1;
		if (p.inputs.down) moveY -= 1;
		if (p.inputs.left) moveX -= 1;
		if (p.inputs.right) moveX += 1;
		// normalize diagonal
		if (moveX !== 0 || moveY !== 0) {
			const len = Math.hypot(moveX, moveY);
			moveX /= len;
			moveY /= len;
		}
		p.x += moveX * PLAYER_SPEED * dt;
		p.y += moveY * PLAYER_SPEED * dt;
		p.x = clamp(p.x, -MAP_HALF_SIZE + PLAYER_RADIUS, MAP_HALF_SIZE - PLAYER_RADIUS);
		p.y = clamp(p.y, -MAP_HALF_SIZE + PLAYER_RADIUS, MAP_HALF_SIZE - PLAYER_RADIUS);
		p.angle = p.inputs.aimingAngle || 0;

		// shooting
		if (p.inputs.shooting && now - p.lastShotAt >= SHOOT_COOLDOWN_MS) {
			const dirX = Math.cos(p.angle);
			const dirY = Math.sin(p.angle);
			bullets.push({
				x: p.x + dirX * (PLAYER_RADIUS + 8),
				y: p.y + dirY * (PLAYER_RADIUS + 8),
				vx: dirX * BULLET_SPEED,
				vy: dirY * BULLET_SPEED,
				ownerId: p.id,
				spawnAt: now
			});
			p.lastShotAt = now;
		}
	}

	// Update bullets
	for (let i = bullets.length - 1; i >= 0; i--) {
		const b = bullets[i];
		b.x += b.vx * dt;
		b.y += b.vy * dt;
		if (
			now - b.spawnAt > BULLET_LIFETIME_MS ||
			Math.abs(b.x) > MAP_HALF_SIZE + 100 ||
			Math.abs(b.y) > MAP_HALF_SIZE + 100
		) {
			bullets.splice(i, 1);
			continue;
		}

		// collision with players
		for (const id in players) {
			const p = players[id];
			if (p.id === b.ownerId || p.health <= 0) continue;
			const r = PLAYER_RADIUS + BULLET_RADIUS;
			if (distanceSquared(b.x, b.y, p.x, p.y) <= r * r) {
				p.health -= 34; // 3 hits to KO approx
				if (p.health <= 0) {
					// score and respawn
					const owner = players[b.ownerId];
					if (owner) owner.score += 1;
					const pos = spawnPosition();
					p.x = pos.x;
					p.y = pos.y;
					p.health = MAX_HEALTH;
				}
				bullets.splice(i, 1);
				break;
			}
		}
	}
}, 1000 / TICK_RATE);

// Broadcast state at a lower rate
setInterval(() => {
	const snapshot = {
		players: Object.values(players).map((p) => ({
			id: p.id,
			x: p.x,
			y: p.y,
			angle: p.angle,
			score: p.score,
			health: p.health
		})),
		bullets: bullets.map((b) => ({ x: b.x, y: b.y })),
		serverTime: Date.now(),
		mapHalfSize: MAP_HALF_SIZE,
		maxHealth: MAX_HEALTH
	};
	io.emit('state', snapshot);
}, 1000 / BROADCAST_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});

