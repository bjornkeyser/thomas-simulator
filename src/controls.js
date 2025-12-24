export class Controls {
    constructor(animationController, camera) {
        this.animation = animationController;
        this.camera = camera;
        this.enabled = true;

        // Mouse look state
        this.isDragging = false;
        this.previousMouseX = 0;
        this.previousMouseY = 0;
        this.cameraYaw = -Math.PI / 3;   // Horizontal rotation (start 60° right)
        this.cameraPitch = -0.1; // Vertical rotation (start slightly down)

        // Apply initial rotation
        if (this.camera) {
            this.camera.rotation.order = 'YXZ';
            this.camera.rotation.y = this.cameraYaw;
            this.camera.rotation.x = this.cameraPitch;
        }
        this.sensitivity = 0.003;

        // Pitch limits (don't flip upside down)
        this.minPitch = -Math.PI / 3;  // Look down limit
        this.maxPitch = Math.PI / 3;   // Look up limit

        // Bind event handlers
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);

        // Set up listeners
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('mouseleave', this.onMouseUp);
    }

    onMouseDown(event) {
        if (!this.enabled) return;
        this.isDragging = true;
        this.previousMouseX = event.clientX;
        this.previousMouseY = event.clientY;
        document.body.style.cursor = 'grabbing';
    }

    onMouseMove(event) {
        if (!this.enabled || !this.isDragging) return;

        const deltaX = event.clientX - this.previousMouseX;
        const deltaY = event.clientY - this.previousMouseY;

        // Update yaw (horizontal) and pitch (vertical) - inverted for "grab world" feel
        this.cameraYaw += deltaX * this.sensitivity;
        this.cameraPitch += deltaY * this.sensitivity;

        // Clamp pitch to prevent flipping
        this.cameraPitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.cameraPitch));

        // Apply rotation to camera
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.cameraYaw;
        this.camera.rotation.x = this.cameraPitch;

        this.previousMouseX = event.clientX;
        this.previousMouseY = event.clientY;
    }

    onMouseUp() {
        this.isDragging = false;
        document.body.style.cursor = 'grab';
    }

    onKeyDown(event) {
        if (!this.enabled) return;

        // Ignore if typing in an input
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
            return;
        }

        const key = event.key.toLowerCase();

        switch (key) {
            case 'd':
                if (this.animation.startDrink()) {
                    this.flashHint('drink');
                }
                break;

            case 's':
                if (this.animation.startSmoke()) {
                    this.flashHint('smoke');
                }
                break;
        }
    }

    flashHint(action) {
        // Visual feedback when action is triggered
        const hint = document.querySelector(`#controls-hint span:${action === 'drink' ? 'first' : 'last'}-child`);
        if (hint) {
            hint.style.color = 'rgba(255, 255, 255, 1)';
            hint.style.borderColor = 'rgba(255, 255, 255, 0.5)';

            setTimeout(() => {
                hint.style.color = '';
                hint.style.borderColor = '';
            }, 200);
        }
    }

    setEnabled(enabled) {
        this.enabled = enabled;
    }

    dispose() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('mousedown', this.onMouseDown);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('mouseleave', this.onMouseUp);
    }
}
