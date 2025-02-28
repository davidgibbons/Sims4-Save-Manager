🏠 Sims 4 Save Manager

A simple save file backup & restore tool for The Sims 4, designed for quick backups, restore points, and save file organization.
🚀 Never lose a save again!
📜 Features

✅ One-click backup of your Sims 4 save files
✅ Add notes to each backup for easy reference
✅ Restore any backup with a preview of all saved versions
✅ Old saves are safely moved instead of deleted
✅ Modern UI with CustomTkinter for a polished look
✅ Automatically remembers selected folders
💻 How to Use

    Download & Run
        Clone this repository or download the .py file.
        Run the script using Python:

        python sims_save_manager_v2.py

        (Coming Soon: .exe standalone version!)

    Select Your Save & Backup Folder
        Choose your Sims 4 save folder (Documents/Electronic Arts/The Sims 4/saves).
        Choose where backups should be stored.

    Backup Your Saves
        Click "Backup Saves" to create a save backup.
        Optionally, add a note (e.g., "Before my Sim got married").

    Restore a Save
        Click "Restore Saves" to view all backups.
        Select one and restore it.
        The current save files will be moved to a "Restored Backup" folder just in case.

📁 File Structure

Sims4SaveManager/
│── Backups/                 # Stores all backups (each in its own timestamped folder)
│── sims_save_manager_v2.py  # The main script
│── config.json              # Stores selected folders for quick access
│── SimsSaveIcon.ico         # App icon
│── README.md                # This file

🛠️ Requirements

✅ Python 3.8+
✅ Install dependencies:

pip install customtkinter

🚀 Future Plans

    Add support for other games with local save files
    UI improvements & dark mode toggle
    Auto-scheduled backups

📜 License

MIT License - Use, modify, and share freely!
🤝 Contributions

Want to help improve the Sims 4 Save Manager?
Feel free to submit a pull request or open an issue!
🌟 Enjoy hassle-free save management & never lose your Sims again! 🎮
