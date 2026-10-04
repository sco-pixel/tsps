import type { Camera } from "../../Camera";
import type { InputKeyHandler, InputManager, InputMouseHandler } from "../../InputManager";
import type { CameraFollowContext, CameraInputContext, ClientPlugin } from "../ClientPluginManager";
import { RS_TO_RADIANS } from "../../../rs/MathConstants";

if (typeof document !== "undefined") require("./FirstPersonPlugin.css");

type FirstPersonClient = {
    camera: Camera;
    inputManager: InputManager;
    renderSelf: boolean;
    firstPersonArmsVisible?: boolean;
    followPlayerCamera: boolean;
    menuOpen: boolean;
    isLoggedIn(): boolean;
    addGameMessage(message: string): void;
    closeMenu(): void;
    getLocalPlayerTile?(): { x: number; y: number } | undefined;
    walkToLocalTile?(localX: number, localY: number): void;
    setLocalPlayerFacingLock?(rot: number | undefined): void;
};

type CursorMode = "none" | "alt" | "menu";
const MENU_ANCHOR_Y_OFFSET = 12;
const CONTROLS_HINT = "Press Alt for mouse look. Press Insert to hide arm visibility.";
const WALK_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
// Tiles ahead of the player to aim each WASD walk; re-aimed as the player moves.
const WALK_LOOKAHEAD_TILES = 4;
const WALK_RESEND_MS = 150;
const SCENE_SIZE = 104;

export class FirstPersonPlugin implements ClientPlugin, InputKeyHandler, InputMouseHandler {
    private enabled = false;
    private cursorMode: CursorMode = "none";
    private awaitingMenuOpen = false;
    private menuOpenChecked = false;
    private menuPointerX = 0;
    private menuPointerY = 0;
    private restoreRenderSelf?: boolean;
    private restoreFollowPlayerCamera?: boolean;
    private controlsHintShown = false;
    private readonly walkKeys = new Set<string>();
    private walking = false;
    private facingLocked = false;
    private lastWalkTarget?: { x: number; y: number };
    private lastWalkSentAt = 0;

    constructor(private readonly client: FirstPersonClient) {
        client.inputManager.addKeyHandler(this);
        client.inputManager.addMouseHandler(this);
    }

    onKeyDown(event: KeyboardEvent): boolean {
        if (WALK_KEYS.has(event.code) && this.canWalk()) {
            this.walkKeys.add(event.code);
            return true;
        }
        if (event.code === "Backquote" && !event.repeat) {
            this.setEnabled(!this.enabled);
            return true;
        }
        if (
            event.code === "Insert" &&
            this.enabled &&
            this.cursorMode !== "menu" &&
            !event.repeat
        ) {
            this.client.firstPersonArmsVisible = !this.client.firstPersonArmsVisible;
            return true;
        }
        if (
            (event.code === "AltLeft" || event.code === "AltRight") &&
            this.enabled &&
            !event.repeat
        ) {
            if (this.cursorMode === "alt") this.resumeMouseLook();
            else this.unlockCursor();
            return true;
        }
        return false;
    }

    onKeyUp(event: KeyboardEvent): boolean {
        if (this.walkKeys.delete(event.code)) {
            if (this.walkKeys.size === 0) this.stopWalking();
            return true;
        }
        return this.enabled && (event.code === "AltLeft" || event.code === "AltRight");
    }

    onMouseDown(event: MouseEvent): void {
        if (!this.enabled || event.button !== 0 && event.button !== 2) return;
        if (event.button === 2 && this.cursorMode === "none") {
            this.awaitingMenuOpen = true;
            this.menuOpenChecked = false;
            this.menuPointerX = this.client.camera.viewportXOffset + this.client.camera.viewportWidth / 2;
            this.menuPointerY = this.client.camera.viewportYOffset + this.client.camera.viewportHeight / 2;
            this.client.inputManager.setContextMenuAnchorOverride(
                this.menuPointerX,
                this.menuPointerY - MENU_ANCHOR_Y_OFFSET,
            );
            this.cursorMode = "menu";
            return;
        }
        if (this.cursorMode !== "menu" || !this.client.menuOpen) return;
        if (event.button === 0) {
            // Leave the menu state intact until its existing click handler invokes or cancels it.
            this.setMenuClickPosition();
            this.resumeMouseLook();
        } else if (event.button === 2) {
            this.closeWorldMenu();
            this.client.inputManager.clickMode1 = 0;
            this.client.inputManager.clickMode2 = 0;
            if (this.cursorMode === "menu") this.resumeMouseLook();
        }
    }

    onMouseMove(event: MouseEvent): void {
        if (!this.enabled || this.cursorMode !== "menu") return;
        const canvas = this.client.inputManager.element as HTMLCanvasElement | undefined;
        const width = canvas?.width ?? 0;
        const height = canvas?.height ?? 0;
        this.menuPointerX = Math.max(0, Math.min(width, this.menuPointerX + event.movementX));
        this.menuPointerY = Math.max(0, Math.min(height, this.menuPointerY + event.movementY));
        this.client.inputManager.mouseX = this.menuPointerX;
        this.client.inputManager.mouseY = this.menuPointerY;
    }

    handleCameraKeys({ camera, input, deltaTime }: CameraInputContext): boolean {
        if (!this.enabled) return false;
        const deltaPitch = (64 * 8 * deltaTime) / 1000;
        const deltaYaw = (512 * deltaTime) / 1000;
        // First-person arrows intentionally run opposite to the normal camera controls.
        if (input.isKeyDown("ArrowUp")) camera.setViewPitchOverride((camera.getViewPitchOverride() ?? 0) - deltaPitch);
        if (input.isKeyDown("ArrowDown")) camera.setViewPitchOverride((camera.getViewPitchOverride() ?? 0) + deltaPitch);
        if (input.isKeyDown("ArrowRight")) camera.updateYaw(camera.yaw, deltaYaw);
        if (input.isKeyDown("ArrowLeft")) camera.updateYaw(camera.yaw, -deltaYaw);
        this.updateWalking(camera);
        return true;
    }

    handleCameraMouse({ camera, input }: CameraInputContext): boolean {
        if (!this.enabled) return false;
        if (this.client.menuOpen) {
            if (this.cursorMode === "none") this.enterMenuMode();
            this.awaitingMenuOpen = false;
        } else if (
            this.cursorMode === "menu" &&
            (!this.awaitingMenuOpen || this.menuOpenChecked)
        ) {
            this.resumeMouseLook();
        }
        if (this.cursorMode !== "none" || !input.isPointerLock()) return true;
        const deltaX = input.getDeltaMouseX();
        const deltaY = input.getDeltaMouseY();
        if (deltaX !== 0 || deltaY !== 0) {
            camera.setViewPitchOverride((camera.getViewPitchOverride() ?? 0) - deltaY * 0.9);
            camera.updateYaw(camera.yaw, -deltaX * 0.9);
        }
        return true;
    }

    handleCameraScroll({ camera, input }: CameraInputContext): boolean {
        if (!this.enabled || input.wheelDeltaY === 0) return false;
        camera.setViewZoomScale(camera.getViewZoomScale() - input.wheelDeltaY * 0.001);
        return true;
    }

    updateInteractionPointer(camera: Camera): void {
        const input = this.client.inputManager;
        this.updateLoginSession();
        this.updateReticleVisibility();
        if (!this.client.isLoggedIn()) {
            input.clearInteractionPointerOverride();
            return;
        }
        if (this.cursorMode === "menu" && this.client.menuOpen) {
            input.clearInteractionPointerOverride();
            input.mouseX = this.menuPointerX;
            input.mouseY = this.menuPointerY;
            this.updateReticlePosition(input, this.menuPointerX, this.menuPointerY);
            return;
        }
        const waitingForMenu = this.cursorMode === "menu" && !this.client.menuOpen;
        if (
            !this.enabled ||
            (!waitingForMenu && this.cursorMode !== "none") ||
            (this.cursorMode === "none" && !input.isPointerLock())
        ) {
            input.clearInteractionPointerOverride();
            return;
        }
        const x = camera.viewportXOffset + camera.viewportWidth / 2;
        const y = camera.viewportYOffset + camera.viewportHeight / 2;
        input.mouseX = x;
        input.mouseY = y;
        input.setInteractionPointerOverride(x, y);
        if (waitingForMenu) this.menuOpenChecked = true;
        this.updateReticlePosition(input, x, y);
    }

    handleCameraFollow({ camera, playerX, playerY, playerZ }: CameraFollowContext): boolean {
        if (!this.enabled) return false;
        camera.snapToPosition(
            playerX,
            playerY === undefined ? undefined : Math.round((playerY - 1.5) * 128) / 128,
            playerZ,
        );
        return true;
    }

    shouldKeepWorldMenuOpen(): boolean {
        return this.enabled && this.client.menuOpen;
    }

    private setEnabled(enabled: boolean): void {
        this.walkKeys.clear();
        this.stopWalking();
        if (this.facingLocked) {
            this.client.setLocalPlayerFacingLock?.(undefined);
            this.facingLocked = false;
        }
        this.enabled = enabled;
        this.cursorMode = enabled ? "alt" : "none";
        this.awaitingMenuOpen = false;
        this.menuOpenChecked = false;
        const { inputManager: input, camera } = this.client;
        input.enablePointerLock = false;
        input.clearInteractionPointerOverride();
        input.clearContextMenuAnchorOverride();
        this.closeWorldMenu();
        this.updateReticleVisibility();
        if (enabled) {
            if (this.updateLoginSession() && !this.controlsHintShown) {
                this.client.addGameMessage(CONTROLS_HINT);
                this.controlsHintShown = true;
            }
            this.restoreRenderSelf = this.client.renderSelf;
            this.restoreFollowPlayerCamera = this.client.followPlayerCamera;
            this.client.renderSelf = false;
            this.client.firstPersonArmsVisible = true;
            this.client.followPlayerCamera = true;
            camera.setViewPitchOverride(0);
            return;
        }
        camera.setViewPitchOverride(undefined);
        camera.setViewZoomScale(1);
        if (this.restoreRenderSelf !== undefined) this.client.renderSelf = this.restoreRenderSelf;
        this.client.firstPersonArmsVisible = false;
        if (this.restoreFollowPlayerCamera !== undefined) this.client.followPlayerCamera = this.restoreFollowPlayerCamera;
        this.restoreRenderSelf = undefined;
        this.restoreFollowPlayerCamera = undefined;
        input.releasePointerLock();
    }

    /** WASD walking is only active while mouse look holds the cursor. */
    private canWalk(): boolean {
        return (
            this.enabled &&
            this.cursorMode === "none" &&
            !this.client.menuOpen &&
            this.client.inputManager.isPointerLock() &&
            this.client.isLoggedIn()
        );
    }

    private updateWalking(camera: Camera): void {
        // Face the body where the camera looks so WASD strafes/backpedals instead of
        // turning the player (and the first-person arms) toward each walk direction.
        const facingLocked = this.canWalk();
        if (facingLocked || this.facingLocked) {
            this.client.setLocalPlayerFacingLock?.(facingLocked ? (camera.yaw + 1024) & 2047 : undefined);
            this.facingLocked = facingLocked;
        }
        if (this.walkKeys.size === 0) return;
        if (!this.canWalk()) {
            this.walkKeys.clear();
            this.stopWalking();
            return;
        }
        const forward = (this.walkKeys.has("KeyW") ? 1 : 0) - (this.walkKeys.has("KeyS") ? 1 : 0);
        const strafe = (this.walkKeys.has("KeyD") ? 1 : 0) - (this.walkKeys.has("KeyA") ? 1 : 0);
        const tile = this.client.getLocalPlayerTile?.();
        if ((forward === 0 && strafe === 0) || !tile) return;
        if (tile.x < 0 || tile.y < 0 || tile.x >= SCENE_SIZE || tile.y >= SCENE_SIZE) return;
        // Camera forward/right on the ground plane in local tile axes, derived from
        // the view matrix Camera.update builds (rotateY(yaw) then a 180° roll).
        const angle = (camera.yaw - 1024) * RS_TO_RADIANS;
        const dirX = -Math.sin(angle) * forward - Math.cos(angle) * strafe;
        const dirY = -Math.cos(angle) * forward + Math.sin(angle) * strafe;
        const scale = WALK_LOOKAHEAD_TILES / Math.hypot(dirX, dirY);
        const target = {
            x: Math.max(0, Math.min(SCENE_SIZE - 1, tile.x + Math.round(dirX * scale))),
            y: Math.max(0, Math.min(SCENE_SIZE - 1, tile.y + Math.round(dirY * scale))),
        };
        const now = performance.now();
        const sameTarget = this.lastWalkTarget?.x === target.x && this.lastWalkTarget.y === target.y;
        if (sameTarget || now - this.lastWalkSentAt < WALK_RESEND_MS) return;
        this.client.walkToLocalTile?.(target.x, target.y);
        this.lastWalkTarget = target;
        this.lastWalkSentAt = now;
        this.walking = true;
    }

    /** Halts on the server's current tile so releasing WASD doesn't finish the lookahead. */
    private stopWalking(): void {
        if (!this.walking) return;
        this.walking = false;
        this.lastWalkTarget = undefined;
        const tile = this.client.getLocalPlayerTile?.();
        if (tile && this.client.isLoggedIn()) this.client.walkToLocalTile?.(tile.x, tile.y);
    }

    private updateLoginSession(): boolean {
        const loggedIn = this.client.isLoggedIn();
        if (!loggedIn) this.controlsHintShown = false;
        return loggedIn;
    }

    private unlockCursor(): void {
        this.walkKeys.clear();
        this.stopWalking();
        this.cursorMode = "alt";
        this.client.inputManager.enablePointerLock = false;
        this.client.inputManager.clearInteractionPointerOverride();
        this.client.inputManager.releasePointerLock();
    }

    private resumeMouseLook(): void {
        this.cursorMode = "none";
        this.awaitingMenuOpen = false;
        this.menuOpenChecked = false;
        this.client.inputManager.enablePointerLock = true;
        this.client.inputManager.clearInteractionPointerOverride();
        this.client.inputManager.clearContextMenuAnchorOverride();
        this.client.inputManager.requestPointerLock();
    }

    private closeWorldMenu(): void {
        this.client.closeMenu();
        const canvas = this.client.inputManager.element as
            | (HTMLCanvasElement & { __ui?: { menu?: { source?: string; open?: boolean } } })
            | undefined;
        if (canvas?.__ui?.menu?.source === "map") {
            canvas.__ui.menu.open = false;
            canvas.__ui.menu = undefined;
        }
    }

    private enterMenuMode(): void {
        this.cursorMode = "menu";
        this.menuPointerX = this.client.camera.viewportXOffset + this.client.camera.viewportWidth / 2;
        this.menuPointerY = this.client.camera.viewportYOffset + this.client.camera.viewportHeight / 2;
    }

    private setMenuClickPosition(): void {
        const input = this.client.inputManager;
        input.mouseX = this.menuPointerX;
        input.mouseY = this.menuPointerY;
        input.clickX = this.menuPointerX;
        input.clickY = this.menuPointerY;
    }

    private updateReticlePosition(input: InputManager, x: number, y: number): void {
        const canvas = input.element as HTMLCanvasElement | undefined;
        const host = canvas?.parentElement;
        if (host && canvas?.width && canvas.height) {
            host.style.setProperty("--first-person-reticle-x", `${(x / canvas.width) * 100}%`);
            host.style.setProperty("--first-person-reticle-y", `${(y / canvas.height) * 100}%`);
        }
    }

    private updateReticleVisibility(): void {
        this.client.inputManager.element?.parentElement?.classList.toggle(
            "first-person-reticle",
            this.enabled && this.client.isLoggedIn(),
        );
    }
}
