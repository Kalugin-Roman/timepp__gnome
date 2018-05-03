const St           = imports.gi.St;
const Gio          = imports.gi.Gio
const Gtk          = imports.gi.Gtk;
const Meta         = imports.gi.Meta;
const GLib         = imports.gi.GLib;
const Clutter      = imports.gi.Clutter;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Main         = imports.ui.main;
const PopupMenu    = imports.ui.popupMenu;
const Signals      = imports.signals;
const Mainloop     = imports.mainloop;


const ME = imports.misc.extensionUtils.getCurrentExtension();


const Gettext  = imports.gettext.domain(ME.metadata['gettext-domain']);
const _        = Gettext.gettext;
const ngettext = Gettext.ngettext;


const SIG_MANAGER  = ME.imports.lib.signal_manager;
const KEY_MANAGER  = ME.imports.lib.keybinding_manager;
const FUZZ         = ME.imports.lib.fuzzy_search;
const MISC_UTILS   = ME.imports.lib.misc_utils;
const PANEL_ITEM   = ME.imports.lib.panel_item;
const REG          = ME.imports.lib.regex;


const G = ME.imports.sections.todo.GLOBAL;


const TIME_TRACKER       = ME.imports.sections.todo.time_tracker;
const TASK               = ME.imports.sections.todo.task_item;
const VIEW_MANAGER       = ME.imports.sections.todo.view_manager;
const VIEW_STATS         = ME.imports.sections.todo.view__stats;
const VIEW_CLEAR         = ME.imports.sections.todo.view__clear_tasks;
const VIEW_SORT          = ME.imports.sections.todo.view__sort;
const VIEW_FILTERS       = ME.imports.sections.todo.view__filters;
const VIEW_TASK_EDITOR   = ME.imports.sections.todo.view__task_editor;
const VIEW_FILE_SWITCHER = ME.imports.sections.todo.view__file_switcher;


const CACHE_FILE = GLib.get_home_dir() +
                   '/.cache/timepp_gnome_shell_extension/timepp_todo.json';



// =====================================================================
// @@@ Main
//
// @ext      : obj (main extension object)
// @settings : obj (extension settings)
//
// @signals:
//   - 'new-day' (new day started) (returns string in yyyy-mm-dd iso format)
// =====================================================================
var SectionMain = class extends ME.imports.sections.section_base.SectionBase {
    constructor (section_name, ext, settings) {
        super(section_name, ext, settings);

        this.actor.add_style_class_name('todo-section');

        this.separate_menu = this.settings.get_boolean('todo-separate-menu');

        this.cache_file   = null;
        this.cache        = null;
        this.sigm         = new SIG_MANAGER.SignalManager();
        this.keym         = new KEY_MANAGER.KeybindingManager(this.settings);
        this.view_manager = new VIEW_MANAGER.ViewManager(this.ext, this);
        this.time_tracker = null;

        // The view manager only allows one view to be visible at time; however,
        // since the stats view uses the fullscreen iface, it is orthogonal to
        // the other views, so we don't use the view manager for it.
        this.stats_view = new VIEW_STATS.StatsView(this.ext, this, 0);


        //
        // init cache file
        //
        try {
            this.cache_file = Gio.file_new_for_path(CACHE_FILE);

            let cache_format_version =
                ME.metadata['cache-file-format-version'].todo;

            if (this.cache_file.query_exists(null)) {
                let [, contents] = this.cache_file.load_contents(null);
                this.cache = JSON.parse(contents);
            }

            if (!this.cache || !this.cache.format_version ||
                this.cache.format_version !== cache_format_version) {

                this.cache = {
                    format_version: cache_format_version,

                    sort: [
                        [G.SortType.PIN             , G.SortOrder.DESCENDING],
                        [G.SortType.COMPLETED       , G.SortOrder.ASCENDING],
                        [G.SortType.PRIORITY        , G.SortOrder.ASCENDING],
                        [G.SortType.DUE_DATE        , G.SortOrder.ASCENDING],
                        [G.SortType.RECURRENCE      , G.SortOrder.ASCENDING],
                        [G.SortType.CONTEXT         , G.SortOrder.ASCENDING],
                        [G.SortType.PROJECT         , G.SortOrder.ASCENDING],
                        [G.SortType.CREATION_DATE   , G.SortOrder.ASCENDING],
                        [G.SortType.COMPLETION_DATE , G.SortOrder.ASCENDING],
                    ],

                    filters: {
                        invert_filters : false,
                        defer          : false,
                        recurring      : false,
                        hidden         : false,
                        completed      : false,
                        no_priority    : false,
                        priorities     : [],
                        contexts       : [],
                        projects       : [],
                        custom         : [],
                        custom_active  : [],
                    },
                };
            }
        } catch (e) {
            logError(e);
            return;
        }


        // We use this for tracking when a new day begins.
        this.wallclock = new GnomeDesktop.WallClock();


        // Track how many tasks have a particular proj/context/prio, a
        // recurrence, etc...
        // The func _reset_stats_obj defines the form of this object.
        this.stats = null;
        this._reset_stats_obj();


        // A GFile to the todo.txt file, GMonitor.
        this.todo_txt_file     = null;
        this.todo_file_monitor = null;


        // @NOTE
        // this.tasks, this.tasks_viewport and the popup menu are the
        // only places where refs to task objects can be held for longer periods
        // of time.
        // If a task has been removed from this.tasks, then it has to also be
        // removed from this.tasks_viewport and it's actor has to be removed
        // from the popup menu.
        //
        // - To ADD a task, create the object and add it to this.tasks and call
        //   this.on_tasks_changed() soon after that.
        //   When creating a large number of tasks all at once, it's best to use
        //   the async func this.create_tasks().
        //
        // - To DELETE a task, remove the object from this.tasks and call
        //   on_tasks_changed() soon after that.
        //
        // - To EDIT a task, create a new task_str and call the task objects'
        //   reset method with the new string, and call on_tasks_changed()
        //   soon after that.
        //
        // Note that on_tasks_changed() does not update the todo.txt file. Use
        // write_tasks_to_file() for that.


        // All task objects.
        this.tasks = [];


        // Array of all tasks that have been filtered. Only tasks in this array
        // can be added to the popup menu.
        this.tasks_viewport = [];


        // @SPEED
        // This is used by the _do_search func to store search queries and their
        // results for the duration of the search.
        //
        // @key : string (a search query)
        // @val : array  (of tasks that match the search query)
        this.search_dictionary = new Map();


        // The last string that was searched for.
        this.last_search_pattern = '';


        // @SPEED
        // Mainloop source id's of the corresponding async funcs.
        // If null, the corresponding func is not running.
        this.create_tasks_mainloop_id      = null;
        this.add_tasks_to_menu_mainloop_id = null;


        // @SPEED
        // Tweak this function to completely disable animations when closing
        // the popup menu in order to avoid lag when there are lots of items.
        this.ext.menu.close = function () {
            if (this._boxPointer.actor.visible) {
                this._boxPointer.hide(false, () => this.emit('menu-closed'));
            }
            if (!this.isOpen) return;
            this.isOpen = false;
            this.emit('open-state-changed', false);
        };


        //
        // keybindings
        //
        this.keym.add('todo-keybinding-open', () => {
            this.ext.open_menu(this.section_name);
            if (this.view_manager.current_view !== G.View.LOADING &&
                this.view_manager.current_view !== G.View.NO_TODO_FILE &&
                this.view_manager.current_view !== G.View.EDITOR) {

                this.show_view__default();
            }
        });
        this.keym.add('todo-keybinding-open-to-add', () => {
            this.ext.open_menu(this.section_name);
            if (this.view_manager.current_view !== G.View.LOADING &&
                this.view_manager.current_view !== G.View.NO_TODO_FILE) {

                this.show_view__task_editor();
            }
        });
        this.keym.add('todo-keybinding-open-to-search', () => {
            this.ext.open_menu(this.section_name);
            if (this.view_manager.current_view !== G.View.LOADING &&
                this.view_manager.current_view !== G.View.NO_TODO_FILE &&
                this.view_manager.current_view !== G.View.EDITOR) {

                this.show_view__search();
            }
        });
        this.keym.add('todo-keybinding-open-to-stats', () => {
            if (this.view_manager.current_view !== G.View.LOADING &&
                this.view_manager.current_view !== G.View.NO_TODO_FILE &&
                this.view_manager.current_view !== G.View.EDITOR) {

                this.show_view__time_tracker_stats();
            }
        });
        this.keym.add('todo-keybinding-open-to-switch-files', () => {
            this.ext.open_menu(this.section_name);
            if (this.view_manager.current_view !== G.View.LOADING &&
                this.view_manager.current_view !== G.View.NO_TODO_FILE &&
                this.view_manager.current_view !== G.View.EDITOR &&
                this.settings.get_value('todo-files').deep_unpack().length > 1) {

                this.show_view__file_switcher();
            }
        });
        this.keym.add('todo-keybinding-open-todotxt-file', () => {
            if (! this.todo_txt_file) return;
            let path = this.todo_txt_file.get_path();
            if (path) MISC_UTILS.open_file_path(path);
        });


        //
        // panel item
        //
        this.panel_item.actor.add_style_class_name('todo-panel-item');
        this.panel_item.icon.icon_name = 'timepp-todo-symbolic';
        this._toggle_panel_item_mode();


        //
        // search entry bin
        //
        this.search_entry_bin = new PopupMenu.PopupMenuItem('', { hover: false, activate: false });
        this.actor.add_actor(this.search_entry_bin.actor);
        this.search_entry_bin.label.hide();
        this.search_entry_bin.actor.hide();
        this.search_entry_bin.actor.can_focus = false;

        this.search_entry = new St.Entry({ can_focus: true });
        this.search_entry_bin.actor.add(this.search_entry, {expand: true});

        this.close_icon = new St.Icon({ icon_name: 'timepp-close-symbolic' });
        this.search_entry.set_secondary_icon(this.close_icon);


        //
        // loading message
        //
        this.loading_msg = new PopupMenu.PopupMenuItem(_('Loading...'), { hover: false, activate: false, style_class: 'loading-msg' });
        this.actor.add_actor(this.loading_msg.actor);
        this.loading_msg.actor.hide();
        this.loading_msg.label.can_focus = true;
        this.loading_msg.actor.can_focus = false;


        //
        // no todo file message
        //
        this.no_todo_file_msg = new PopupMenu.PopupMenuItem(_('Select todo file in settings...'), { hover: false, activate: false, style_class: 'no-todo-file-msg' });
        this.actor.add_actor(this.no_todo_file_msg.actor);
        this.no_todo_file_msg.actor.hide();
        this.no_todo_file_msg.label.can_focus = true;
        this.no_todo_file_msg.actor.can_focus = false;


        //
        // header
        //
        this.header = new PopupMenu.PopupMenuItem('', { hover: false, activate: false, style_class: 'header' });
        this.actor.add_actor(this.header.actor);
        this.header.label.hide();
        this.header.actor.hide();
        this.header.actor.can_focus = false;

        this.add_task_button = new St.Button({ can_focus: true, x_align: St.Align.START, style_class: 'add-task' });
        this.header.actor.add(this.add_task_button, { expand: true });

        this.add_task_bin = new St.BoxLayout();
        this.add_task_button.add_actor(this.add_task_bin);

        this.add_task_icon = new St.Icon({ icon_name: 'timepp-plus-symbolic', y_align: Clutter.ActorAlign.CENTER });
        this.add_task_bin.add_actor(this.add_task_icon);

        this.add_task_label = new St.Label({ text: _('Add New Task...'), y_align: Clutter.ActorAlign.CENTER });
        this.add_task_bin.add_actor(this.add_task_label);


        //
        // header icons
        //
        this.icon_box = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, style_class: 'icon-box' });
        this.header.actor.add(this.icon_box);

        this.filter_icon = new St.Icon({ can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'filter-icon' });
        this.icon_box.add_child(this.filter_icon);

        this.sort_icon = new St.Icon({ can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'sort-icon' });
        this.icon_box.add_child(this.sort_icon);

        this.file_switcher_icon = new St.Icon({ icon_name: 'timepp-file-symbolic', can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'file-switcher-icon' });
        this.icon_box.add_child(this.file_switcher_icon);
        this.file_switcher_icon.visible = (this.settings.get_value('todo-files').deep_unpack().length > 1);

        this.search_icon = new St.Icon({ icon_name: 'timepp-search-symbolic', can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'search-icon' });
        this.icon_box.add_child(this.search_icon);

        this.stats_icon = new St.Icon({ icon_name: 'timepp-graph-symbolic', can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'stats-icon' });
        this.icon_box.add_child(this.stats_icon);

        this.clear_icon = new St.Icon({ icon_name: 'timepp-clear-symbolic', can_focus: true, reactive: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'clear-icon' });
        this.icon_box.add_child(this.clear_icon);


        //
        // task items box
        //
        this.tasks_scroll_wrapper = new St.BoxLayout({ style_class: 'popup-menu-item' });
        this.actor.add(this.tasks_scroll_wrapper, {expand: true});

        // @HACK
        // Using the PopupMenuItem as a wrapper won't work here if there is
        // a large num of tasks. Various event listeners in PopupMenuItem
        // will cause major lag when entering the wrapper with the mouse.
        // We replicate the PopupMenuItem by adding an ornament to ensure
        // proper horizontal padding.
        {
            let ornament = new St.Label({style_class: 'popup-menu-ornament' });
            this.tasks_scroll_wrapper.add_actor(ornament);
        }

        this.tasks_scroll = new St.ScrollView({ style_class: 'tasks-container vfade', x_fill: true, y_align: St.Align.START});
        this.tasks_scroll_wrapper.add(this.tasks_scroll, {expand: true});

        this.tasks_scroll.hscrollbar_policy = Gtk.PolicyType.NEVER;

        this.tasks_scroll_content = new St.BoxLayout({ vertical: true, style_class: 'tasks-content-box'});
        this.tasks_scroll.add_actor(this.tasks_scroll_content);


        //
        // listen
        //
        this.sigm.connect(this.settings, 'changed::todo-files', () => {
            let todo_files = this.settings.get_value('todo-files').deep_unpack();
            if (todo_files.length > 1) this.file_switcher_icon.show();
            else                       this.file_switcher_icon.hide();
        });
        this.sigm.connect(this.settings, 'changed::todo-current', () => {
            this._init_todo_file();
        });
        this.sigm.connect(this.settings, 'changed::todo-separate-menu', () => {
            this.separate_menu = this.settings.get_boolean('todo-separate-menu');
            this.ext.update_panel_items();
        });
        this.sigm.connect(this.settings, 'changed::todo-show-seconds', () => {
            this._update_time_display();
        });
        this.sigm.connect(this.settings, 'changed::todo-panel-mode', () => {
            this._toggle_panel_item_mode();
        });
        this.sigm.connect(this.settings, 'changed::todo-task-width', () => {
            let width = this.settings.get_int('todo-task-width');
            for (let task of this.tasks)
                task.actor.width = width;
        });
        this.sigm.connect(this.wallclock, 'notify::clock', () => {
            let t = GLib.DateTime.new_now(this.wallclock.timezone);
            t     = t.format('%H:%M');

            if (t === '00:00') this._on_new_day_started();
        });
        this.sigm.connect(this.panel_item, 'left-click', () => this.ext.toggle_menu(this.section_name));
        this.sigm.connect_press(this.add_task_button, Clutter.BUTTON_PRIMARY, true, () => this.show_view__task_editor());
        this.sigm.connect_press(this.filter_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__filters());
        this.sigm.connect_press(this.filter_icon, Clutter.BUTTON_MIDDLE, false, () => this.toggle_invert_filters());
        this.sigm.connect_press(this.sort_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__sort());
        this.sigm.connect_press(this.file_switcher_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__file_switcher());
        this.sigm.connect_press(this.search_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__search());
        this.sigm.connect_press(this.stats_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__time_tracker_stats());
        this.sigm.connect_press(this.clear_icon, Clutter.BUTTON_PRIMARY, true, () => this.show_view__clear_completed());
        this.sigm.connect(this.search_entry, 'secondary-icon-clicked', () => this.show_view__default());
        this.sigm.connect(this.ext, 'custom-css-changed', () => this._on_custom_css_changed());
        this.sigm.connect(this.search_entry.clutter_text, 'text-changed', () => Mainloop.idle_add(() => this._search()));


        //
        // finally
        //
        this._init_todo_file();
    }

    disable_section () {
        if (this.create_tasks_mainloop_id) {
            Mainloop.source_remove(this.create_tasks_mainloop_id);
            this.create_tasks_mainloop_id = null;
        }

        if (this.add_tasks_to_menu_mainloop_id) {
            Mainloop.source_remove(this.add_tasks_to_menu_mainloop_id);
            this.add_tasks_to_menu_mainloop_id = null;
        }

        if (this.todo_file_monitor) {
            this.todo_file_monitor.cancel();
            this.todo_file_monitor = null;
        }

        if (this.time_tracker) {
            this.time_tracker.close();
            this.time_tracker = null;
        }

        if (this.view_manager) {
            this.view_manager = null;
        }

        if (this.stats_view) {
            this.stats_view.destroy();
            this.stats_view = null;
        }

        this.sigm.clear();
        this.keym.clear();

        this.tasks          = [];
        this.tasks_viewport = [];

        this.tasks_scroll_content.destroy_all_children();

        super.disable_section();
    }

    _init_todo_file () {
        // reset
        {
            if (this.create_tasks_mainloop_id) {
                Mainloop.source_remove(this.create_tasks_mainloop_id);
                this.create_tasks_mainloop_id = null;
            }

            if (this.time_tracker) {
                this.time_tracker.close();
                this.time_tracker = null;
            }

            if (this.todo_file_monitor) {
                this.todo_file_monitor.cancel();
                this.todo_file_monitor = null;
            }

            this.stats.priorities.clear();
            this.stats.contexts.clear();
            this.stats.projects.clear();

            this.tasks_viewport = [];
            this.tasks_scroll_content.remove_all_children();
        }

        let current = this.settings.get_value('todo-current').deep_unpack();

        if (! current.todo_file) {
            this.show_view__no_todo_file();
            return;
        }

        try {
            // todo file
            this.todo_txt_file = Gio.file_new_for_uri(current.todo_file);

            if (this.todo_file_monitor)
                this.todo_file_monitor.cancel();

            this.todo_file_monitor =
                this.todo_txt_file.monitor_file(Gio.FileMonitorFlags.NONE, null);

            this.todo_file_monitor.connect(
                'changed', (...args) => this._on_todo_file_changed(args[3]));

            if (!this.todo_txt_file || !this.todo_txt_file.query_exists(null)) {
                this.show_view__no_todo_file();
                return;
            }
        } catch (e) {
            logError(e);
            return;
        }

        this.show_view__loading();

        let [, lines] = this.todo_txt_file.load_contents(null);
        lines = String(lines).split(/\r?\n/).filter((l) => /\S/.test(l));

        this.create_tasks(lines, () => {
            if (this._check_dates()) this.write_tasks_to_file();
            this.on_tasks_changed();
            this.show_view__default();
            this.time_tracker = new TIME_TRACKER.TimeTracker(this.ext, this);
        });
    }

    store_cache () {
        if (!this.cache_file || !this.cache_file.query_exists(null))
            this.cache_file.create(Gio.FileCreateFlags.NONE, null);

        this.cache_file.replace_contents(JSON.stringify(this.cache, null, 2),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    write_tasks_to_file () {
        this.file_monitor_handler_block = true;

        let res = '';

        let len = this.tasks.length;
        for (let i = 0; i < len; i++) res += this.tasks[i].task_str + '\n';

        if (!this.todo_txt_file || !this.todo_txt_file.query_exists(null))
            this.cache_file.create(Gio.FileCreateFlags.NONE, null);

        this.todo_txt_file.replace_contents(res, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    _on_todo_file_changed (event_type) {
        // @HACK
        // The normal handler_block/unblock methods don't work with a file
        // monitor for some reason. This seems to work well enough.
        if (this.file_monitor_handler_block) {
            Mainloop.idle_add(() => {
                this.file_monitor_handler_block = false;
            });
            return;
        }

        if (event_type === Gio.FileMonitorEvent.DELETED ||
            event_type === Gio.FileMonitorEvent.MOVED   ||
            event_type === Gio.FileMonitorEvent.CREATED) {

            this._init_todo_file();
            return;
        }

        if (event_type !== undefined &&
            event_type !== Gio.FileMonitorEvent.CHANGES_DONE_HINT) {

            return;
        }

        this._init_todo_file();
    }

    _on_new_day_started () {
        this.emit('new-day', G.date_yyyymmdd());

        if (this._check_dates()) {
            this.write_tasks_to_file();
            this.on_tasks_changed();
        }
    }

    _check_dates () {
        let today          = G.date_yyyymmdd();
        let tasks_updated  = false;
        let recurred_tasks = 0;
        let deferred_tasks = 0;

        for (let task of this.tasks) {
            if (task.check_recurrence()) {
                tasks_updated = true;
                recurred_tasks++;
            }

            if (task.check_deferred_tasks(today)) {
                tasks_updated = true;
                deferred_tasks++;
            }

            task.update_dates_markup();
        }

        if (tasks_updated) {
            if (recurred_tasks > 0) {
                Main.notify(ngettext('%d task has recurred',
                                     '%d tasks have recurred',
                                      recurred_tasks).format(recurred_tasks));
            }

            if (deferred_tasks > 0) {
                Main.notify(ngettext('%d deferred task has been opened',
                                     '%d deferred tasks have been opened',
                                      deferred_tasks).format(deferred_tasks));
            }
        }

        return tasks_updated;
    }

    _on_custom_css_changed () {
        for (let task of this.tasks) {
            task.update_body_markup();
            task.update_dates_markup();
        }
    }

    // The maps have the structure:
    // @key : string  (a context/project/priority)
    // @val : natural (number of tasks that have that @key)
    _reset_stats_obj () {
        this.stats = {
            deferred_tasks        : 0,
            recurring_completed   : 0,
            recurring_incompleted : 0,
            hidden                : 0,
            completed             : 0,
            no_priority           : 0,
            priorities            : new Map(),
            contexts              : new Map(),
            projects              : new Map(),
        };
    }

    _toggle_panel_item_mode () {
        if (this.settings.get_enum('todo-panel-mode') === 0)
            this.panel_item.set_mode('icon');
        else if (this.settings.get_enum('todo-panel-mode') === 1)
            this.panel_item.set_mode('text');
        else
            this.panel_item.set_mode('icon_text');
    }

    // Create task objects from the given task strings and add them to the
    // this.tasks array.
    //
    // Make sure to call this.on_tasks_changed() soon after calling this func.
    //
    // @todo_strings : array (of strings; each string is a line in todo.txt file)
    // @callback     : func
    create_tasks (todo_strings, callback) {
        if (this.create_tasks_mainloop_id) {
            Mainloop.source_remove(this.create_tasks_mainloop_id);
            this.create_tasks_mainloop_id = null;
        }

        if (this.add_tasks_to_menu_mainloop_id) {
            Mainloop.source_remove(this.add_tasks_to_menu_mainloop_id);
            this.add_tasks_to_menu_mainloop_id = null;
        }

        // Since we are reusing already instantiated objects, get rid of any
        // excess task object.
        //
        // @NOTE Reusing old objects can be the source of evil...
        {
            let len = todo_strings.length;
            while (this.tasks.length > len) this.tasks.pop().actor.destroy();
        }

        this.create_tasks_mainloop_id = Mainloop.idle_add(() => {
            this._create_tasks__finish(0, todo_strings, callback);
        });
    }

    _create_tasks__finish (i, todo_strings, callback) {
        if (i === todo_strings.length) {
            if (typeof(callback) === 'function') callback();
            this.create_tasks_mainloop_id = null;
            return;
        }

        let str = todo_strings[i];

        if (this.tasks[i])
            this.tasks[i].reset(false, str);
        else
            this.tasks.push(new TASK.TaskItem(this.ext, this, str, false));

        this.create_tasks_mainloop_id = Mainloop.idle_add(() => {
            this._create_tasks__finish(++i, todo_strings, callback);
        });
    }

    // This func must be called soon after 1 or more tasks have been added, or
    // removed from this.tasks array or when they have been edited.
    //
    // This func should not be called many times in a row. The idea is to add,
    // delete, or edit all tasks first and then call this func once.
    //
    // It will handle various things like updating the stats obj, showing or
    // hiding various icons, sorting tasks, etc...
    //
    // This func will not write tasks to the todo.txt file.
    on_tasks_changed () {
        //
        // Update stats obj
        //
        {
            this._reset_stats_obj();

            let n, proj, context;

            for (let task of this.tasks) {
                if (task.is_deferred) {
                    this.stats.deferred_tasks++;
                    continue;
                }

                if (task.completed) {
                    if (task.rec_str) this.stats.recurring_completed++
                    else              this.stats.completed++;
                    continue;
                }

                for (proj of task.projects) {
                    n = this.stats.projects.get(proj);
                    this.stats.projects.set(proj, n ? ++n : 1);
                }

                for (context of task.contexts) {
                    n = this.stats.contexts.get(context);
                    this.stats.contexts.set(context, n ? ++n : 1);
                }

                if (task.hidden) {
                    this.stats.hidden++;
                    continue;
                }

                if (task.priority === '(_)') {
                    this.stats.no_priority++;
                }
                else {
                    n = this.stats.priorities.get(task.priority);
                    this.stats.priorities.set(task.priority, n ? ++n : 1);
                }

                if (task.rec_str) this.stats.recurring_incompleted++;
            }
        }


        //
        // update panel label
        //
        {
            let n_incompleted = this.tasks.length -
                                this.stats.completed -
                                this.stats.hidden -
                                this.stats.recurring_completed -
                                this.stats.deferred_tasks;

            this.panel_item.set_label('' + n_incompleted);

            if (n_incompleted)
                this.panel_item.actor.remove_style_class_name('done');
            else
                this.panel_item.actor.add_style_class_name('done');
        }


        //
        // Since contexts/projects/priorities are filters, it can happen that we
        // have redundant filters in case tasks were deleted. Clean 'em up.
        //
        {
            let i, arr, len;

            arr = this.cache.filters.priorities;
            for (i = 0, len = arr.length; i < len; i++) {
                if (! this.stats.priorities.has(arr[i])) {
                    arr.splice(i, 1);
                    len--; i--;
                }
            }

            arr = this.cache.filters.contexts;
            for (i = 0, len = arr.length; i < len; i++) {
                if (! this.stats.contexts.has(arr[i])) {
                    arr.splice(i, 1);
                    len--; i--;
                }
            }

            arr = this.cache.filters.projects;
            for (i = 0, len = arr.length; i < len; i++) {
                if (! this.stats.projects.has(arr[i])) {
                    arr.splice(i, 1);
                    len--; i--;
                }
            }

            this._update_filter_icon();
        }


        //
        // rest
        //
        this.clear_icon.visible = this.stats.completed > 0;
        this.sort_tasks();
        this.add_tasks_to_menu(true);
    }

    // Add actors of task objects from this.tasks_viewport to the popup menu.
    // Only this function should be used to add task actors to the popup menu.
    //
    // If @update_tasks_viewport is true, then the tasks viewport will be
    // rebuilt (i.e., all tasks will be run through the filter test again.)
    //
    // @update_tasks_viewport : bool
    // @ignore_filters        : bool (only makes sense if @update_tasks_viewport
    //                                is true)
    add_tasks_to_menu (update_tasks_viewport, ignore_filters) {
        if (this.add_tasks_to_menu_mainloop_id) {
            Mainloop.source_remove(this.add_tasks_to_menu_mainloop_id);
            this.add_tasks_to_menu_mainloop_id = null;
        }

        update_tasks_viewport = Boolean(update_tasks_viewport);
        ignore_filters        = Boolean(ignore_filters);

        this.tasks_scroll.vscrollbar_policy = Gtk.PolicyType.NEVER;

        this.tasks_scroll_content.remove_all_children();
        if (update_tasks_viewport) this.tasks_viewport = [];

        let arr = update_tasks_viewport ? this.tasks : this.tasks_viewport;
        let n   = Math.min(arr.length, 21);

        for (let i = 0; i < n; i++) {
            if (update_tasks_viewport) {
                if (ignore_filters || this._filter_test(arr[i])) {
                    this.tasks_viewport.push(arr[i]);
                    this.tasks_scroll_content.add_child(arr[i].actor);
                }
            }
            else this.tasks_scroll_content.add_child(arr[i].actor);

            arr[i].actor.visible = this.ext.menu.isOpen &&
                                   this.tasks_scroll_wrapper.visible;
        }

        this.add_tasks_to_menu_mainloop_id = Mainloop.idle_add(() => {
           this._add_tasks_to_menu__finish(n, arr, update_tasks_viewport,
                                           ignore_filters, false);
        });
    }

    _add_tasks_to_menu__finish (i, arr, update_tasks_viewport, ignore_filters,
                                scrollbar_shown) {

        if (!scrollbar_shown && this.ext.needs_scrollbar()) {
            this.tasks_scroll.vscrollbar_policy = Gtk.PolicyType.ALWAYS;
            scrollbar_shown = true;
        }

        if (i === arr.length) {
            this.add_tasks_to_menu_mainloop_id = null;
            return;
        }

        if (update_tasks_viewport) {
            if (ignore_filters || this._filter_test(arr[i])) {
                this.tasks_viewport.push(arr[i]);
                this.tasks_scroll_content.add_child(arr[i].actor);
            }
        }
        else this.tasks_scroll_content.add_child(arr[i].actor);

        arr[i].actor.visible = this.ext.menu.isOpen &&
                               this.tasks_scroll_wrapper.visible;

        this.add_tasks_to_menu_mainloop_id = Mainloop.idle_add(() => {
            this._add_tasks_to_menu__finish(++i, arr, update_tasks_viewport,
                                            ignore_filters, scrollbar_shown);
        });
    }

    // Append the task strings of each given task to the current done.txt file.
    //
    // If a given task is not completed, it's task string will be updated to
    // show that it's completed prior to been appended to the done.txt file.
    //
    // The task objects will not be changed.
    //
    // @tasks: array (of task objects)
    archive_tasks (tasks) {
        let content = '';
        let today   = G.date_yyyymmdd();
        let task;

        for (let i = 0, len = tasks.length; i < len; i++) {
            task = tasks[i];

            if (task.completed) {
                content += task.task_str + '\n';
            }
            else {
                if (task.priority === '(_)')
                    content += `x ${today} ${task.task_str}\n`;
                else
                    content += `x ${today} ${task.task_str.slice(3)} \
                                pri:${task.priority[1]}\n`;
            }
        }

        try {
            let current = this.settings.get_value('todo-current').deep_unpack();
            let done_file = Gio.file_new_for_uri(current.done_file);
            let append_stream = done_file.append_to(Gio.FileCreateFlags.NONE, null);

            append_stream.write_all(content, null);
        }
        catch (e) { logError(e); }
    }

    show_view__no_todo_file () {
        this.panel_item.set_mode('icon');
        this.panel_item.actor.remove_style_class_name('done');

        this.view_manager.show_view({
            view_name      : G.View.NO_TODO_FILE,
            actors         : [this.no_todo_file_msg.actor],
            focused_actor  : this.no_todo_file_msg.label,
            close_callback : () => { this.no_todo_file_msg.actor.hide(); },
        });
    }

    show_view__loading () {
        this.panel_item.set_mode('icon');
        this.panel_item.actor.remove_style_class_name('done');
        this.panel_item.icon.icon_name = 'timepp-todo-loading-symbolic';

        this.view_manager.show_view({
            view_name      : G.View.LOADING,
            actors         : [this.loading_msg.actor],
            focused_actor  : this.loading_msg.label,
            close_callback : () => {
                this.loading_msg.actor.hide();
                this.panel_item.icon.icon_name = 'timepp-todo-symbolic';
                this._toggle_panel_item_mode();
            },
        });
    }

    show_view__default () {
        this.view_manager.show_view({
            view_name      : G.View.DEFAULT,
            actors         : [this.header.actor, this.tasks_scroll_wrapper],
            focused_actor  : this.add_task_button,
            close_callback : () => {
                this.header.actor.hide();
                this.tasks_scroll_wrapper.hide();
            },
        });
    }

    show_view__clear_completed () {
        let box = new VIEW_CLEAR.ClearCompletedTasks(this.ext, this);

        this.view_manager.show_view({
            view_name      : G.View.CLEAR,
            actors         : [box.actor],
            focused_actor  : box.button_cancel,
            close_callback : () => { box.actor.destroy(); },
        });

        box.connect('delete-all', () => {
            let incompleted_tasks = [];

            for (let i = 0, len = this.tasks.length; i < len; i++) {
                if (!this.tasks[i].completed || this.tasks[i].rec_str)
                    incompleted_tasks.push(this.tasks[i]);
            }

            this.tasks = incompleted_tasks;
            this.on_tasks_changed();
            this.write_tasks_to_file();
            this.show_view__default();
        });

        box.connect('archive-all', () => {
            let completed_tasks   = [];
            let incompleted_tasks = [];

            for (let i = 0, len = this.tasks.length; i < len; i++) {
                if (!this.tasks[i].completed || this.tasks[i].rec_str)
                    incompleted_tasks.push(this.tasks[i]);
                else
                    completed_tasks.push(this.tasks[i]);
            }

            this.archive_tasks(completed_tasks);
            this.tasks = incompleted_tasks;
            this.on_tasks_changed();
            this.write_tasks_to_file();
            this.show_view__default();
        });

        box.connect('cancel', () => {
            this.show_view__default();
        });
    }

    show_view__time_tracker_stats (task) {
        this.ext.menu.close();
        this.stats_view.open();

        if (this.time_tracker.stats_data.size === 0)
            this.stats_view.show_mode__banner(_('Loading...'));

        Mainloop.idle_add(() => {
            let stats = this.time_tracker.get_stats();

            if (!stats) {
                this.stats_view.show_mode__banner(_('Nothing found.'));
            } else if (!task) {
                this.stats_view.set_stats(...stats);
                this.stats_view.show_mode__global(G.date_yyyymmdd());
            } else {
                this.stats_view.set_stats(...stats);
                let d = new Date();
                this.stats_view.show_mode__single(d.getFullYear(), d.getMonth(), task.task_str, '()');
            }
        });
    }

    show_view__search () {
        if (this.add_tasks_to_menu_mainloop_id) {
            Mainloop.source_remove(this.add_tasks_to_menu_mainloop_id);
            this.add_tasks_to_menu_mainloop_id = null;
        }

        this.view_manager.show_view({
            view_name      : G.View.SEARCH,
            focused_actor  : this.search_entry,
            actors         : [
                this.search_entry_bin.actor,
                this.tasks_scroll_wrapper
            ],
            close_callback : () => {
                this.search_entry.set_text('');
                this.search_dictionary.clear();
                this.search_entry_bin.actor.hide();
                this.tasks_scroll_wrapper.hide();
                this.add_tasks_to_menu(true);
            },
        });

        // We always search all tasks no matter what filters are active, so
        // add all tasks to the popup menu.
        this.add_tasks_to_menu(true, true);
    }

    show_view__file_switcher () {
        let filter_switcher =
            new VIEW_FILE_SWITCHER.TodoFileSwitcher(this.ext, this);

        this.view_manager.show_view({
            view_name      : G.View.FILE_SWITCH,
            actors         : [filter_switcher.actor],
            focused_actor  : filter_switcher.entry.entry,
            close_callback : () => { filter_switcher.close(); },
        });

        filter_switcher.connect('switch', (_, name) => {
            let todo_files = this.settings.get_value('todo-files').deep_unpack();
            let current;

            for (let i = 0, len = todo_files.length; i < len; i++) {
                if (todo_files[i].name === name) {
                    current = todo_files[i];
                    break;
                }
            }

            this.settings.set_value('todo-current',
                                    GLib.Variant.new('a{ss}', current));
        });

        filter_switcher.connect('close', () => {
            this.show_view__default();
        });
    }

    show_view__sort () {
        let sort_window = new VIEW_SORT.TaskSortWindow(this.ext, this);

        this.view_manager.show_view({
            view_name      : G.View.SELECT_SORT,
            actors         : [sort_window.actor],
            focused_actor  : sort_window.button_ok,
            close_callback : () => { sort_window.actor.destroy(); },
        });

        sort_window.connect('update-sort', (_, new_sort_obj) => {
            this.cache.sort = new_sort_obj;
            this.store_cache();
            this.sort_tasks();
            this.add_tasks_to_menu(true);
            this.show_view__default();
        });
    }

    show_view__filters () {
        let filters_window = new VIEW_FILTERS.TaskFiltersWindow(this.ext, this);

        this.view_manager.show_view({
            view_name      : G.View.SELECT_FILTER,
            actors         : [filters_window.actor],
            focused_actor  : filters_window.entry.entry,
            close_callback : () => { filters_window.actor.destroy(); },
        });

        filters_window.connect('filters-updated', (_, filters) => {
            this.cache.filters = filters;
            this.store_cache();
            this._update_filter_icon();
            this.add_tasks_to_menu(true);
            this.show_view__default();
        });
    }

    show_view__task_editor (task) {
        let editor = new VIEW_TASK_EDITOR.TaskEditor(this.ext, this, task);

        this.view_manager.show_view({
            view_name      : G.View.EDITOR,
            actors         : [editor.actor],
            focused_actor  : editor.entry.entry,
            close_callback : () => { editor.actor.destroy(); },
        });

        if (task) this.time_tracker.stop_tracking(task);

        editor.connect('add-task', (_, task_str) => {
            this.tasks.unshift(new TASK.TaskItem(this.ext, this, task_str, true));
            this.on_tasks_changed();
            this.write_tasks_to_file();
            this.show_view__default();
        });

        editor.connect('delete-task', (_, do_archive) => {
            if (do_archive) this.archive_tasks([task]);

            for (let i = 0, len = this.tasks.length; i < len; i++) {
                if (this.tasks[i] === task) {
                    this.tasks.splice(i, 1);
                    break;
                }
            }

            this.on_tasks_changed();
            this.write_tasks_to_file();
            this.show_view__default();
        });

        editor.connect('edit-task', (_, task_str) => {
            task.reset(true, task_str);
            this.on_tasks_changed();
            this.write_tasks_to_file();
            this.show_view__default();
        });

        editor.connect('cancel', () => {
            this.show_view__default();
        });
    }

    // @task: obj (a task object)
    //
    // A predicate used to determine whether a task inside the this.tasks array
    // will be added to this.tasks_viewport array (i.e., whether it can be
    // visible to the user).
    //
    // If invert_filters is false, return true if at least one filter is matched.
    // If invert_filters is true,  return false if at least one filter is matched.
    _filter_test (task) {
        if (task.pinned)                    return true;
        if (this.cache.filters.hidden)      return task.hidden;
        if (task.hidden)                    return false;
        if (this.cache.filters.deferred)    return task.is_deferred;
        if (this.cache.filters.recurring)   return Boolean(task.rec_str);
        if (task.rec_str && task.completed) return false;
        if (task.is_deferred)               return false;
        if (! this.has_active_filters())    return true;

        if (task.completed) {
            if (this.cache.filters.completed)
                return !this.cache.filters.invert_filters;
        }
        else if (task.priority === '(_)') {
            if (this.cache.filters.no_priority)
                return !this.cache.filters.invert_filters;
        }

        for (let it of this.cache.filters.priorities) {
            if (it === task.priority)
                return !this.cache.filters.invert_filters;
        }

        for (let it of this.cache.filters.contexts) {
            if (task.contexts.indexOf(it) !== -1)
                return !this.cache.filters.invert_filters;
        }

        for (let it of this.cache.filters.projects) {
            if (task.projects.indexOf(it) !== -1)
                return !this.cache.filters.invert_filters;
        }

        for (let it of this.cache.filters.custom_active) {
            if (FUZZ.fuzzy_search_v1(it, task.task_str) !== null)
                return !this.cache.filters.invert_filters;
        }

        return this.cache.filters.invert_filters;
    }

    // Returns true if there are any active filters, else false.
    has_active_filters () {
        if (this.cache.filters.deferred          ||
            this.cache.filters.recurring         ||
            this.cache.filters.hidden            ||
            this.cache.filters.completed         ||
            this.cache.filters.no_priority       ||
            this.cache.filters.priorities.length ||
            this.cache.filters.contexts.length   ||
            this.cache.filters.projects.length   ||
            this.cache.filters.custom_active.length) {

            return true;
        }

        return false;
    }

    // @keyword: string (priority, context, or project)
    toggle_filter (keyword) {
        let arr;

        if      (REG.TODO_PRIO.test(keyword))    arr = this.cache.filters.priorities;
        else if (REG.TODO_CONTEXT.test(keyword)) arr = this.cache.filters.contexts;
        else if (REG.TODO_PROJ.test(keyword))    arr = this.cache.filters.projects;

        let idx = arr.indexOf(keyword);

        if (idx === -1) arr.push(keyword);
        else            arr.splice(idx, 1);

        this.store_cache();
        this._update_filter_icon();
        if (this.view_manager.current_view === G.View.DEFAULT)
            this.add_tasks_to_menu(true);
    }

    toggle_invert_filters () {
        this.cache.filters.invert_filters = !this.cache.filters.invert_filters;
        this.store_cache();
        this.on_tasks_changed();
    }

    _update_filter_icon () {
        if (this.cache.filters.invert_filters) {
            this.filter_icon.icon_name = 'timepp-filter-inverted-symbolic';
        } else {
            this.filter_icon.icon_name = 'timepp-filter-symbolic';
        }

        if (this.has_active_filters()) {
            this.filter_icon.add_style_class_name('active');
        } else {
            this.filter_icon.remove_style_class_name('active');
        }
    }

    // This func will sort this.tasks array as well as call add_tasks_to_menu to
    // rebuild this.tasks_viewport.
    sort_tasks () {
        let property_map = {
            [G.SortType.PIN]             : 'pinned',
            [G.SortType.COMPLETED]       : 'completed',
            [G.SortType.PRIORITY]        : 'priority',
            [G.SortType.DUE_DATE]        : 'due_date',
            [G.SortType.RECURRENCE]      : 'rec_next',
            [G.SortType.CONTEXT]         : 'first_context',
            [G.SortType.PROJECT]         : 'first_project',
            [G.SortType.CREATION_DATE]   : 'creation_date',
            [G.SortType.COMPLETION_DATE] : 'completion_date',
        };

        let i     = 0;
        let len   = this.cache.sort.length;
        let props = Array(len);

        for (; i < len; i++) {
            props[i] = property_map[ this.cache.sort[i][0] ];
        }

        this.tasks.sort((a, b) => {
            for (i = 0; (i < len) && (a[props[i]] === b[props[i]]); i++);

            if (i === len) return 0;

            switch (this.cache.sort[i][0]) {
                case G.SortType.PRIORITY:
                    if (this.cache.sort[i][1] === G.SortOrder.DESCENDING) {
                        return +(a[props[i]] > b[props[i]]) ||
                               +(a[props[i]] === b[props[i]]) - 1;
                    } else {
                        return +(a[props[i]] < b[props[i]]) ||
                               +(a[props[i]] === b[props[i]]) - 1;
                    }

                default:
                    if (this.cache.sort[i][1] === G.SortOrder.DESCENDING) {
                        return +(a[props[i]] < b[props[i]]) ||
                               +(a[props[i]] === b[props[i]]) - 1;
                    } else {
                        return +(a[props[i]] > b[props[i]]) ||
                               +(a[props[i]] === b[props[i]]) - 1;
                    }
            }
        });

        this.sort_icon.icon_name =
            this.cache.sort[0][1] === G.SortOrder.ASCENDING ?
            'timepp-sort-ascending-symbolic' :
            'timepp-sort-descending-symbolic';
    }

    // Each search query and the corresponding array of results (task objects)
    // is stored in a dictionary. If the current search query is in the dict, we
    // just use the corresponding results. If a search query in the dict is a
    // prefix of the current search query, we execute a search on the results
    // of the prefix query (search space reduced.)
    //
    // The dictionary is only maintained for the duration of the search.
    _search () {
        if (this.view_manager.current_view !== G.View.SEARCH)
            return;

        if (this.add_tasks_to_menu_mainloop_id) {
            Mainloop.source_remove(this.add_tasks_to_menu_mainloop_id);
            this.add_tasks_to_menu_mainloop_id = null;
        }

        let pattern = this.search_entry.get_text().trim().toLowerCase();

        if (pattern === '') {
            this.last_search_pattern = '';
            this.tasks_viewport = this.tasks;
            this.add_tasks_to_menu();
            return;
        }

        this.last_search_pattern = pattern;
        let [search_needed, search_space] = this._find_prev_search_results(pattern);

        if (! search_needed) {
            this.tasks_viewport = search_space;
            this.add_tasks_to_menu();
            return;
        }

        this._do_search(pattern, search_space);
    }

    _do_search (pattern, search_space) {
        let reduced_results = [];
        let i, len, score;

        for (i = 0, len = search_space.length; i < len; i++) {
            score = FUZZ.fuzzy_search_v1(pattern, search_space[i].task_str.toLowerCase());
            if (score !== null) reduced_results.push([i, score]);
        }

        reduced_results.sort((a, b) => b[1] - a[1]);

        len = reduced_results.length;

        this.tasks_viewport = new Array(len);

        for (i = 0; i < len; i++) {
            this.tasks_viewport[i] = search_space[ reduced_results[i][0] ];
        }

        this.search_dictionary.set(pattern, this.tasks_viewport);
        this.add_tasks_to_menu();
    }

    _find_prev_search_results (pattern) {
        let res = '';

        for (let [old_patt,] of this.search_dictionary) {
            if (pattern.startsWith(old_patt) && old_patt.length > res.length)
                res = old_patt;
        }

        if (pattern === res) return [false, this.search_dictionary.get(res)];
        else if (res)        return [true,  this.search_dictionary.get(res)];
        else                 return [true,  this.tasks];
    }
}; Signals.addSignalMethods(SectionMain.prototype);
